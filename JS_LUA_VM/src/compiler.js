'use strict';
// Compile an AST into canonical bytecode:
//   { functions: [{ name, nparams, nlocals, instrs, upvals }], consts, entry, hostNames }
// Each function's `instrs` is a list of { op, args } where op is a CANONICAL
// opcode id (see opcodes.js) and args are already-resolved numeric operands.
// Jump operands are absolute byte offsets within that function's own stream.
//
// The compiler performs closure conversion: nested function expressions capture
// free variables from enclosing functions as UPVALUES. Each captured variable is
// described by { fromLocal, index } -- fromLocal means "the enclosing frame's
// local cell at `index`", otherwise "the enclosing frame's upvalue at `index`".
// At runtime a CLOSURE instruction wires these to shared cells so mutations are
// visible to every closure over the same variable, and the variable survives
// after the defining function returns.

const { OP, OP_OPERANDS, OP_NAME } = require('./opcodes');
const { parse } = require('./parser');
const { optimize } = require('./optimize');
const { expandImports, hasImports } = require('./modules');
const { applyTransforms } = require('./transforms');

const HOST_BUILTINS = new Set(['len', 'str', 'num', 'floor', 'abs', 'rand', 'time', 'push', 'keys', 'has', 'handlers', 'await', 'createProto']);

// Global string-literal encryption: rewrite every non-empty string literal used
// as a value expression into an equivalent expression that reconstructs it at
// runtime, so the plaintext never appears in the constant pool. Semantics are
// preserved (the expression evaluates to the identical string). `mode` is one of
// str_arr | hex | bytecode | random; `random` picks per-string from a seeded RNG.
function encStrExpr(str, mode, rng) {
  if (mode === 'random') mode = ['str_arr', 'hex', 'bytecode'][rng() % 3];
  if (mode === 'str_arr') {
    const elements = Array.from(str).map((ch) => ({ type: 'Str', value: ch, _enc: true }));
    return { type: 'Call', callee: { type: 'Member', object: { type: 'Array', elements }, property: 'join' }, args: [{ type: 'Str', value: '', _enc: true }] };
  }
  // fromCharCode: chunk into <=200-arg calls joined by '+' -- a call's argument
  // count is a u8, so a single fromCharCode(...) over a long string (or the
  // tree-map blob) would overflow 255 args and corrupt the stack.
  const chars = Array.from(str);
  const CH = 200;
  let expr = null;
  for (let i = 0; i < chars.length; i += CH) {
    const codes = chars.slice(i, i + CH).map((ch) => ({ type: 'Num', value: ch.charCodeAt(0), _enc: true }));
    const call = { type: 'Call', callee: { type: 'Member', object: { type: 'Ident', name: 'String' }, property: 'fromCharCode' }, args: codes };
    expr = expr ? { type: 'Binary', op: '+', left: expr, right: call } : call;
  }
  return expr || { type: 'Str', value: '', _enc: true };
}
// Reconstruct an integer literal at runtime as (A ^ B) so it never appears as a
// plaintext constant. Only u32 integers are eligible; others are left as-is.
function encNumExpr(value, rng) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff || Object.is(value, -0)) return null;
  const A = rng() >>> 0;
  const B = (value ^ A) >>> 0;
  return { type: 'Binary', op: '^', left: { type: 'Num', value: A, _enc: true }, right: { type: 'Num', value: B, _enc: true } };
}
// Global literal obfuscation. `mode` (none|str_arr|hex|bytecode|random) encrypts
// string literals; `encNum` additionally rewrites integer literals into XOR
// reconstructions ("obfuscate table values"). Semantics are preserved.
function encryptStrings(ast, mode, seed, encNum) {
  const doStr = mode && mode !== 'none';
  if (!doStr && !encNum) return ast;
  let s = ((seed !== undefined ? seed : 0x9e3779b9) ^ 0x5bd1e995) >>> 0;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  let count = 0, numCount = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = walk(node[i]); return node; }
    if (doStr && node.type === 'Str' && !node._enc && typeof node.value === 'string' && node.value.length > 0) {
      count++;
      return encStrExpr(node.value, mode, rng);
    }
    if (encNum && node.type === 'Num' && !node._enc && typeof node.value === 'number') {
      const rep = encNumExpr(node.value, rng);
      if (rep) { numCount++; return rep; }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type') continue;
      const v = node[k];
      if (v && typeof v === 'object') node[k] = walk(v);
    }
    return node;
  };
  walk(ast);
  ast._encStrCount = count;
  ast._encNumCount = numCount;
  return ast;
}

// Tree-map string extrapolation: instead of each string sitting in the constant
// pool, all string literals are folded into ONE shared blob with substring
// sharing (a string that already occurs inside the blob -- e.g. "ell" inside
// "hello" -- reuses that region), and every literal becomes `__B.slice(off, end)`.
// No complete original string appears as its own pooled constant, common
// fragments are deduplicated, and the blob itself is stored encoded (never as
// plaintext). Behaviour is preserved (each slice equals the original string).
function treeMapStrings(ast, mode, seed) {
  let s = ((seed !== undefined ? seed : 0x9e3779b9) ^ 0x27d4eb2f) >>> 0;
  const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  // 1. collect every non-empty string literal
  const strs = new Set();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) collect(n); return; }
    if (node.type === 'Str' && !node._enc && typeof node.value === 'string' && node.value.length > 0) strs.add(node.value);
    for (const k of Object.keys(node)) { if (k === 'type') continue; const v = node[k]; if (v && typeof v === 'object') collect(v); }
  };
  collect(ast);
  if (strs.size === 0) { ast._treeCount = 0; return ast; }
  // 2. build the shared blob, longest strings first so shorter ones can be reused
  const arr = [...strs].sort((a, b) => b.length - a.length);
  let blob = '';
  const pos = {};
  for (const str of arr) {
    let at = blob.indexOf(str);
    if (at < 0) { at = blob.length; blob += str; }
    pos[str] = [at, at + str.length];
  }
  // 3. inject `let __B = <encoded blob>` at program top (a global, so nested
  //    functions can reach it), then rewrite every string literal to a slice.
  const blobNode = encStrExpr(blob, mode === 'tree' ? 'hex' : mode, rng); // blob never stored plaintext
  const decl = { type: 'Let', name: '__B', value: blobNode };
  let count = 0;
  const rewrite = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = rewrite(node[i]); return node; }
    if (node.type === 'Str' && !node._enc && typeof node.value === 'string' && node.value.length > 0) {
      const [a, b] = pos[node.value]; count++;
      return { type: 'Call', callee: { type: 'Member', object: { type: 'Ident', name: '__B' }, property: 'slice' }, args: [{ type: 'Num', value: a, _enc: true }, { type: 'Num', value: b, _enc: true }] };
    }
    for (const k of Object.keys(node)) { if (k === 'type') continue; const v = node[k]; if (v && typeof v === 'object') node[k] = rewrite(node[k]); }
    return node;
  };
  rewrite(ast);
  if (ast.type === 'Program' && Array.isArray(ast.body)) ast.body.unshift(decl);
  ast._treeCount = count;
  return ast;
}

function operandBytes(canonOp) {
  let n = 1;
  for (const kind of OP_OPERANDS[canonOp]) n += kind === 'u16' ? 2 : 1;
  return n;
}

class FnEmitter {
  constructor(name, params, compiler, parent) {
    this.name = name;
    this.nparams = params.length;
    this.instrs = [];
    this.compiler = compiler;
    this.parent = parent || null;
    // scope chain for block scoping; slot indices are per-function
    this.scopes = [new Map()];
    this.nextSlot = 0;
    // stack of { brk, cont } label pairs for break/continue inside loops
    this.loops = [];
    // upvalue descriptors captured from enclosing functions
    this.upvals = [];
    this.upvalMap = new Map();
    // exception handler descriptors for this function (label refs resolved later)
    this.handlers = [];
    // slot -> declared source name (persists across scope pops, for build reports)
    this.localNames = {};
    for (const pnam of params) this.declare(pnam);
  }
  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }
  declare(name) {
    const slot = this.nextSlot++;
    this.scopes[this.scopes.length - 1].set(name, slot);
    this.localNames[slot] = name;
    return slot;
  }
  resolveLocal(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    return -1;
  }
  addUpval(fromLocal, index, name) {
    if (this.upvalMap.has(name)) return this.upvalMap.get(name);
    const u = this.upvals.length;
    this.upvals.push({ fromLocal, index, name });
    this.upvalMap.set(name, u);
    return u;
  }
  // Resolve a name captured from an enclosing function into an upvalue index,
  // creating upvalues along the whole parent chain as needed. Returns -1 if the
  // name is not an enclosing local/upvalue (i.e. it is global or undefined).
  resolveUpval(name) {
    if (!this.parent) return -1;
    const pl = this.parent.resolveLocal(name);
    if (pl >= 0) return this.addUpval(true, pl, name);
    const pu = this.parent.resolveUpval(name);
    if (pu >= 0) return this.addUpval(false, pu, name);
    return -1;
  }
  resolve(name) {
    const l = this.resolveLocal(name);
    if (l >= 0) return { kind: 'local', slot: l };
    const u = this.resolveUpval(name);
    if (u >= 0) return { kind: 'upval', index: u };
    return { kind: 'none' };
  }
  emit(op, ...args) { const idx = this.instrs.length; this.instrs.push({ op, args }); return idx; }
  label() { return { pos: -1 }; }
  mark(lbl) { lbl.pos = this.instrs.length; }
}

// Superinstruction fusion rules: (op1, op2) -> fused op. op1 must push exactly
// one value that op2 consumes as its top operand, so the fused form is exactly
// equivalent to the pair. The second instruction of a fused pair must never be a
// jump target (checked by the caller).
function fusionRule(a, b) {
  if (a.op === OP.LOAD && b.op === OP.ADD) return OP.LOADADD;
  if (a.op === OP.LOAD && b.op === OP.SUB) return OP.LOADSUB;
  if (a.op === OP.LOAD && b.op === OP.LT) return OP.LOADLT;
  if (a.op === OP.PUSH_CONST && b.op === OP.ADD) return OP.CONSTADD;
  return -1;
}

// Fuse adjacent instruction pairs. Returns { out, map } where map[oldIndex] is
// the new index, so jump targets can be remapped.
function fuseInstrs(instrs, isTarget) {
  const out = [];
  const map = new Array(instrs.length + 1);
  let i = 0;
  while (i < instrs.length) {
    map[i] = out.length;
    const a = instrs[i];
    const b = instrs[i + 1];
    let fused = -1;
    if (b && !isTarget(i + 1)) fused = fusionRule(a, b);
    if (fused >= 0) {
      out.push({ op: fused, args: [a.args[0]] });
      map[i + 1] = out.length - 1; // b is consumed; nothing targets it
      i += 2;
    } else {
      out.push(a);
      i += 1;
    }
  }
  map[instrs.length] = out.length;
  return { out, map };
}

class Compiler {
  constructor(opts = {}) {
    this.consts = [];
    this.constKey = new Map();     // dedupe pool
    this.functions = [];           // finished function records (flat, global idx)
    this.fnIndex = new Map();      // top-level name -> index
    this.hostNames = [];           // ordered list of host builtin names actually used
    this.hostIndex = new Map();
    this.fuse = opts.fuse === true; // superinstruction fusion (instruction-set polymorphism)
    this.useEnvObjects = opts.useEnvObjects === true; // capture upvalues into explicit env objects
    // Global protection floor applied to EVERY function (per-function <@...>
    // directives merge on top and win). Shape: { flatten, bogus, split, protLevel }.
    this.globalProt = opts.globalProt || null;
    // Per-function overrides keyed by global function index (from the UI / API).
    // Precedence: inline directive > per-function override > global floor.
    this.perFnProt = opts.perFnProt || null;
    // Deterministic RNG for the obfuscation transforms (seeded so builds repeat).
    let s = ((opts.seed !== undefined ? opts.seed : 0x2545f491) ^ 0x6b43a9b5) >>> 0;
    this.transformRng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  }

  constId(value) {
    // Distinguish -0 from 0 (String(-0) === "0" would otherwise dedupe them).
    const key = (typeof value) + ':' + (Object.is(value, -0) ? '-0' : String(value));
    if (this.constKey.has(key)) return this.constKey.get(key);
    const id = this.consts.length;
    this.consts.push(value);
    this.constKey.set(key, id);
    return id;
  }
  hostId(name) {
    if (this.hostIndex.has(name)) return this.hostIndex.get(name);
    const id = this.constId(name); // host name lives in the const pool
    this.hostIndex.set(name, id);
    this.hostNames.push(name);
    return id;
  }

  compileProgram(ast) {
    // Pre-pass: register top-level function declarations so calls can be forward
    // references. main is function 0.
    this.fnIndex.set('$main', 0);
    this.functions.push(null); // placeholder for main
    const topFns = [];
    const topStmts = [];
    for (const stmt of ast.body) {
      if (stmt.type === 'FnDecl') {
        if (this.fnIndex.has(stmt.name)) throw new Error(`Duplicate function '${stmt.name}'`);
        const idx = this.functions.length;
        this.fnIndex.set(stmt.name, idx);
        this.functions.push(null); // reserve
        topFns.push({ idx, stmt });
      } else {
        topStmts.push(stmt);
      }
    }

    // compile main
    const main = new FnEmitter('$main', [], this, null);
    main.isMain = true; // top-level `let` binds into the global environment
    main.globalIndex = 0;
    main.parentIndex = -1; // root of the function tree
    for (const s of topStmts) this.compileStmt(main, s);
    main.emit(OP.HALT);
    this.functions[0] = this.finishFn(main);

    // compile each top-level function
    for (const { idx, stmt } of topFns) {
      const fe = new FnEmitter(stmt.name, stmt.params, this, null);
      fe.globalIndex = idx;
      fe.parentIndex = 0; // top-level functions hang off the root ($main)
      fe.isDecoy = !!stmt._decoy;    // <@decoy> synthesized dead function
      fe.protLevel = stmt.protLevel; // selective-virtualization annotation (may be undefined)
      fe.prot = stmt.prot;           // per-pass modification knobs (flat/bogus/split/...)
      fe.restParam = stmt.restParam;
      fe.generator = !!stmt.generator;
      fe.async = !!stmt.async;
      this.compileBlock(fe, stmt.body, /*ownScope*/ false);
      fe.emit(OP.PUSH_NULL); // implicit "return null" fallthrough
      fe.emit(OP.RET);
      this.functions[idx] = this.finishFn(fe);
    }

    return {
      functions: this.functions,
      consts: this.consts,
      entry: 0,
      hostNames: this.hostNames,
    };
  }

  // Compile a nested function expression, appending it to the flat function
  // table and emitting a CLOSURE in the parent that captures its upvalues.
  compileFnExpr(parentFe, node) {
    const idx = this.functions.length;
    this.functions.push(null); // reserve the slot before compiling the body
    const fe = new FnEmitter(node.name || '$anon', node.params, this, parentFe);
    fe.globalIndex = idx;
    fe.parentIndex = (parentFe && parentFe.globalIndex != null) ? parentFe.globalIndex : 0;
    fe.protLevel = node.protLevel; // selective-virtualization annotation (may be undefined)
    fe.prot = node.prot;           // per-pass modification knobs (flat/bogus/split/...)
    fe.restParam = node.restParam;
    fe.generator = !!node.generator;
    fe.async = !!node.async;
    this.compileBlock(fe, node.body, /*ownScope*/ false);
    fe.emit(OP.PUSH_NULL);
    fe.emit(OP.RET);
    this.functions[idx] = this.finishFn(fe);
    parentFe.emit(OP.CLOSURE, idx);
  }

  // Resolve labels to absolute byte offsets and freeze the function.
  finishFn(fe) {
    let instrs = fe.instrs;
    const origInstrCount = instrs.length; // before CLOSE_UPVALUE + obfuscation passes

    // Inject CLOSE_UPVALUE before each RET for any local slots captured by
    // upvalues. Inserting instructions shifts indices, so jump-target labels
    // ({pos}) must be remapped from old indices to new ones -- otherwise any
    // if/while/for jump past an insertion point lands on the wrong instruction.
    const localsToClose = new Set();
    for (const u of fe.upvals) if (u.fromLocal) localsToClose.add(u.index);
    if (localsToClose.size > 0) {
      const newInstrs = [];
      const map = new Array(instrs.length + 1);
      for (let i = 0; i < instrs.length; i++) {
        map[i] = newInstrs.length; // old index i -> new index (before its content)
        if (instrs[i].op === OP.RET) {
          for (const slot of Array.from(localsToClose)) newInstrs.push({ op: OP.CLOSE_UPVALUE, args: [slot] });
        }
        newInstrs.push(instrs[i]);
      }
      map[instrs.length] = newInstrs.length;
      const seen = new Set();
      for (const ins of newInstrs) {
        for (const a of ins.args) {
          if (a && typeof a === 'object' && 'pos' in a && !seen.has(a)) { a.pos = map[a.pos]; seen.add(a); }
        }
      }
      instrs = newInstrs;
    }

    // Phase-4 control-flow obfuscation (per-function, driven by <@bogus>/<@split>).
    // Semantics-preserving: only bogus/reordered structure is added. Runs on the
    // {pos}-labelled instruction array before offsets are resolved.
    // Merge the global protection floor with any per-function directive (the
    // directive wins on conflict), so `--flatten-all` etc. reach every function.
    // Effective protection = global floor, then per-function override, then the
    // inline directive (each later layer wins).
    let eprot = Object.assign({}, this.globalProt || {});
    if (this.perFnProt && this.perFnProt[fe.globalIndex]) eprot = Object.assign(eprot, this.perFnProt[fe.globalIndex]);
    if (fe.prot) eprot = Object.assign(eprot, fe.prot);
    fe.prot = eprot; // reflect effective settings in the build report
    fe.effProtLevel = eprot.protLevel; // may be undefined
    let preTransformOps = null;
    if (eprot && (eprot.bogus || eprot.split || eprot.flatten)) {
      // snapshot the canonical opcode sequence BEFORE transforms so the build
      // summary can show exactly what <@flat>/<@bogus>/<@split> added.
      preTransformOps = instrs.map((x) => OP_NAME[x.op]);
      instrs = applyTransforms(instrs, eprot, this.transformRng);
    }
    fe.preTransformOps = preTransformOps;

    // Optional superinstruction fusion. Done here, before offsets are computed,
    // with jump targets protected so control flow is preserved exactly.
    if (this.fuse) {
      const targets = new Set();
      for (const ins of instrs) {
        for (const a of ins.args) if (a && typeof a === 'object' && 'pos' in a) targets.add(a.pos);
      }
      const { out, map } = fuseInstrs(instrs, (idx) => targets.has(idx));
      // remap each unique label object's instruction index exactly once
      const seen = new Set();
      for (const ins of out) {
        for (const a of ins.args) {
          if (a && typeof a === 'object' && 'pos' in a && !seen.has(a)) { a.pos = map[a.pos]; seen.add(a); }
        }
      }
      instrs = out;
    }

    const offsets = new Array(instrs.length + 1);
    let off = 0;
    for (let i = 0; i < instrs.length; i++) { offsets[i] = off; off += operandBytes(instrs[i].op); }
    offsets[instrs.length] = off;
    for (const ins of instrs) {
      ins.args = ins.args.map((a) => (a && typeof a === 'object' && 'pos' in a) ? offsets[a.pos] : a);
    }
    return {
      name: fe.name, nparams: fe.nparams, nlocals: fe.nextSlot,
      instrs, byteLen: off,
      // include upvalue name for runtime env access
      upvals: fe.upvals.map((u) => ({ fromLocal: u.fromLocal, index: u.index, name: u.name })),
      // map handler label refs into concrete addresses and export metadata
      handlers: fe.handlers.map((h) => ({ addr: offsets[h.handlerLabel.pos], hasCatch: h.hasCatch, catchName: h.catchName, hasFinalizer: h.hasFinalizer })),
      // cipher rounds: explicit directive wins, else per-fn/global floor, else weak(1)
      protLevel: (fe.protLevel != null) ? fe.protLevel
        : (fe.effProtLevel != null ? fe.effProtLevel : 1),
      prot: fe.prot || null, // per-pass modification knobs (for build reporting)
      restParam: (fe.restParam != null) ? fe.restParam : null,
      generator: !!fe.generator,
      async: !!fe.async,
      // build-report metadata (names + how much the obfuscation passes grew the code)
      localNames: fe.localNames,
      isDecoy: !!fe.isDecoy, // <@decoy> synthesized dead function
      parent: (fe.parentIndex != null) ? fe.parentIndex : -1, // parent fn index (for scope/CFG map)
      origInstrCount,
      finalInstrCount: instrs.length,
      preTransformOps: fe.preTransformOps, // canonical ops before CF passes (for summary)
    };
  }

  compileBlock(fe, block, ownScope = true) {
    if (ownScope) fe.pushScope();
    // Tolerate a single (non-Block) statement body, e.g. `if (x) return y;`.
    if (block.type === 'Block') { for (const s of block.body) this.compileStmt(fe, s); }
    else this.compileStmt(fe, block);
    if (ownScope) fe.popScope();
  }

  // Emit a write to the shared global environment: `__setglobal(name, value)`.
  // The host returns the stored value, so with keepValue the result stays on the
  // stack (assignment-as-expression); otherwise it is discarded.
  emitGlobalSet(fe, name, valueExpr, keepValue) {
    fe.emit(OP.PUSH_CONST, this.constId(name));
    if (valueExpr) this.compileExpr(fe, valueExpr); else fe.emit(OP.PUSH_NULL);
    fe.emit(OP.CALL_HOST, this.hostId('__setglobal'), 2);
    if (!keepValue) fe.emit(OP.POP);
  }
  isGlobalName(fe, name) {
    return fe.resolve(name).kind === 'none' && !this.fnIndex.has(name);
  }

  // Emit a store into a variable resolved as local or upvalue.
  emitStore(fe, name) {
    const r = fe.resolve(name);
    if (r.kind === 'local') fe.emit(OP.STORE, r.slot);
    else if (r.kind === 'upval') {
      if (this.useEnvObjects) {
        // store by upvalue name via const pool
        const upname = fe.upvals[r.index].name;
        fe.emit(OP.STORE_UPVALUE, this.constId(upname));
      } else {
        fe.emit(OP.STORE_UP, r.index);
      }
    } else throw new Error(`Assignment to undeclared variable '${name}'`);
  }

  compileStmt(fe, s) {
    switch (s.type) {
      case 'Let': {
        // At module top level, `let` binds into the shared global environment so
        // top-level functions can close over module-scope variables (like `tests`
        // or counters). Inside functions/blocks it is an ordinary local.
        if (fe.isMain) { this.emitGlobalSet(fe, s.name, s.value, false); break; }
        // `let x;` with no initializer binds null.
        if (s.value) this.compileExpr(fe, s.value);
        else fe.emit(OP.PUSH_NULL);
        const slot = fe.declare(s.name);
        fe.emit(OP.STORE, slot);
        break;
      }
      case 'Assign': {
        if (s.target.type === 'Ident') {
          if (this.isGlobalName(fe, s.target.name)) { this.emitGlobalSet(fe, s.target.name, s.value, false); break; }
          this.compileExpr(fe, s.value);
          this.emitStore(fe, s.target.name);
        } else if (s.target.type === 'Index') {
          this.compileExpr(fe, s.target.object);
          this.compileExpr(fe, s.target.index);
          this.compileExpr(fe, s.value);
          fe.emit(OP.ARR_SET);
          fe.emit(OP.POP);
        } else if (s.target.type === 'Member') {
          this.compileExpr(fe, s.target.object);
          fe.emit(OP.PUSH_CONST, this.constId(s.target.property));
          this.compileExpr(fe, s.value);
          fe.emit(OP.ARR_SET);
          fe.emit(OP.POP);
        } else {
          throw new Error('Invalid assignment target');
        }
        break;
      }
      case 'Print': {
        this.compileExpr(fe, s.value);
        fe.emit(OP.PRINT);
        break;
      }
      case 'Return': {
        if (s.value) this.compileExpr(fe, s.value);
        else fe.emit(OP.PUSH_NULL);
        fe.emit(OP.RET);
        break;
      }
      case 'Throw': {
        this.compileExpr(fe, s.value);
        fe.emit(OP.THROW);
        break;
      }
      case 'If': {
        this.compileExpr(fe, s.test);
        const lElse = fe.label();
        fe.emit(OP.JZ, lElse);
        this.compileBlock(fe, s.cons);
        if (s.alt) {
          const lEnd = fe.label();
          fe.emit(OP.JMP, lEnd);
          fe.mark(lElse);
          if (s.alt.type === 'If') this.compileStmt(fe, s.alt);
          else this.compileBlock(fe, s.alt);
          fe.mark(lEnd);
        } else {
          fe.mark(lElse);
        }
        break;
      }
      case 'While': {
        const lTop = fe.label();
        const lEnd = fe.label();
        fe.mark(lTop);
        this.compileExpr(fe, s.test);
        fe.emit(OP.JZ, lEnd);
        fe.loops.push({ brk: lEnd, cont: lTop }); // continue re-tests the loop
        this.compileBlock(fe, s.body);
        fe.loops.pop();
        fe.emit(OP.JMP, lTop);
        fe.mark(lEnd);
        break;
      }
      case 'For': {
        fe.pushScope();
        if (s.init) this.compileStmt(fe, s.init);
        const lTop = fe.label();
        const lCont = fe.label();
        const lEnd = fe.label();
        fe.mark(lTop);
        if (s.test) { this.compileExpr(fe, s.test); fe.emit(OP.JZ, lEnd); }
        fe.loops.push({ brk: lEnd, cont: lCont }); // continue runs the update
        this.compileBlock(fe, s.body);
        fe.loops.pop();
        fe.mark(lCont);
        if (s.update) this.compileStmt(fe, s.update);
        fe.emit(OP.JMP, lTop);
        fe.mark(lEnd);
        fe.popScope();
        break;
      }
      case 'Break': {
        if (fe.loops.length === 0) throw new Error('break outside of a loop');
        fe.emit(OP.JMP, fe.loops[fe.loops.length - 1].brk);
        break;
      }
      case 'Continue': {
        if (fe.loops.length === 0) throw new Error('continue outside of a loop');
        fe.emit(OP.JMP, fe.loops[fe.loops.length - 1].cont);
        break;
      }
      case 'Try': {
        this.compileTry(fe, s);
        break;
      }
      case 'Block': {
        this.compileBlock(fe, s);
        break;
      }
      case 'ExprStmt': {
        this.compileExpr(fe, s.expr);
        fe.emit(OP.POP); // discard result
        break;
      }
      case 'Seq': {
        // A flattened sequence of statements sharing the current scope (used for
        // destructuring / multi-declarator / import desugaring).
        for (const st of s.body) this.compileStmt(fe, st);
        break;
      }
      case 'Class': {
        // class declaration -> bind the class value like a `let`.
        if (fe.isMain) { this.emitGlobalSet(fe, s.name, s, false); }
        else { this.compileExpr(fe, s); const slot = fe.declare(s.name); fe.emit(OP.STORE, slot); }
        break;
      }
      case 'FnDecl': {
        // Nested function declaration -> a locally-bound closure. The name is
        // declared BEFORE compiling the body so the function can recurse.
        const slot = fe.declare(s.name);
        this.compileFnExpr(fe, { type: 'FnExpr', name: s.name, params: s.params, body: s.body, async: s.async, generator: s.generator, restParam: s.restParam, protLevel: s.protLevel, prot: s.prot, generator: s.generator });
        fe.emit(OP.STORE, slot);
        break;
      }
      default:
        throw new Error(`Unknown statement ${s.type}`);
    }
  }

  // try { B } [catch (e) { C }] [finally { F }]
  //
  //   TRY handler          ; install a catch handler at `handler`
  //     B
  //   END_TRY              ; body completed without throwing
  //     F                  ; normal-path finally
  //   JMP end
  // handler:               ; VM jumps here with the thrown value on the stack
  //     (catch)  STORE e / POP ; C ; F        -- exception handled, run finally
  //     (no catch, finally-only) STORE $exc ; F ; LOAD $exc ; THROW  -- re-raise
  // end:
  //
  // Known limitation: `finally` does not run if the catch body itself throws, or
  // on an early `return` inside the try body.
  compileTry(fe, s) {
    const handler = fe.label();
    const end = fe.label();
    // record handler metadata (label reference resolved when finishing function)
    fe.handlers.push({ handlerLabel: handler, hasCatch: !!s.handler, catchName: s.param || null, hasFinalizer: !!s.finalizer });
    fe.emit(OP.TRY, handler);
    this.compileBlock(fe, s.block);
    fe.emit(OP.END_TRY);
    if (s.finalizer) this.compileBlock(fe, s.finalizer); // normal-path finally
    fe.emit(OP.JMP, end);

    fe.mark(handler);
    fe.pushScope();
    if (s.handler) {
      if (s.param) { const slot = fe.declare(s.param); fe.emit(OP.STORE, slot); }
      else fe.emit(OP.POP);
      this.compileBlock(fe, s.handler, /*ownScope*/ false);
      if (s.finalizer) this.compileBlock(fe, s.finalizer); // caught-path finally
    } else {
      // finally-only: run the finalizer, then re-raise the caught value.
      const slot = fe.declare('$exc');
      fe.emit(OP.STORE, slot);
      this.compileBlock(fe, s.finalizer, /*ownScope*/ false);
      fe.emit(OP.LOAD, slot);
      fe.emit(OP.THROW);
    }
    fe.popScope();
    fe.mark(end);
  }

  compileExpr(fe, e) {
    switch (e.type) {
      case 'Num': fe.emit(OP.PUSH_CONST, this.constId(e.value)); break;
      case 'Str': fe.emit(OP.PUSH_CONST, this.constId(e.value)); break;
      case 'Template': {
        // Start from an empty string so every interpolation is string-concatenated
        // (e.g. `${1}${2}` -> "12", not 3).
        fe.emit(OP.PUSH_CONST, this.constId(''));
        for (const part of e.parts) { this.compileExpr(fe, part); fe.emit(OP.ADD); }
        break;
      }
      case 'Bool': fe.emit(e.value ? OP.PUSH_TRUE : OP.PUSH_FALSE); break;
      case 'Null': fe.emit(OP.PUSH_NULL); break;
      case 'Regex': {
        // build a real RegExp via the host so .test/.match/.replace work
        fe.emit(OP.PUSH_CONST, this.constId(e.pattern));
        fe.emit(OP.PUSH_CONST, this.constId(e.flags || ''));
        fe.emit(OP.CALL_HOST, this.hostId('__regex'), 2);
        break;
      }
      case 'Ident': {
        const r = fe.resolve(e.name);
        if (e.name === 'this') { fe.emit(OP.LOAD_THIS); break; }
        if (e.name === 'arguments' && r.kind === 'none' && !fe.isMain) { fe.emit(OP.LOAD_ARGS); break; }
        if (r.kind === 'local') fe.emit(OP.LOAD, r.slot);
        else if (r.kind === 'upval') {
          if (this.useEnvObjects) fe.emit(OP.LOAD_UPVALUE, this.constId(e.name));
          else fe.emit(OP.LOAD_UP, r.index);
        }
        else if (this.fnIndex.has(e.name)) fe.emit(OP.CLOSURE, this.fnIndex.get(e.name)); // fn as value
        else {
          // Not a local/upvalue/function: read from the shared global environment.
          // This resolves module-scope variables and host globals (console, Object,
          // Math, JSON, Promise, require, ...); unknown names come back undefined.
          fe.emit(OP.PUSH_CONST, this.constId(e.name));
          fe.emit(OP.CALL_HOST, this.hostId('__getglobal'), 1);
        }
        break;
      }
      case 'FnExpr': this.compileFnExpr(fe, e); break;
      case 'Array': {
        const hasSpread = e.elements.some((el) => el && el.type === 'Spread');
        if (!hasSpread) {
          for (const el of e.elements) this.compileExpr(fe, el);
          fe.emit(OP.NEW_ARR, e.elements.length);
          break;
        }
        // real spread: accumulate into a fresh array with push / __extend.
        fe.emit(OP.NEW_ARR, 0);
        for (const el of e.elements) {
          if (!el) continue; // hole
          fe.emit(OP.DUP);
          if (el.type === 'Spread') { this.compileExpr(fe, el.arg); fe.emit(OP.CALL_HOST, this.hostId('__extend'), 2); }
          else { this.compileExpr(fe, el); fe.emit(OP.CALL_HOST, this.hostId('push'), 2); }
          fe.emit(OP.POP);
        }
        break;
      }
      case 'Object': {
        let n = 0;
        const accessors = [];
        for (const pr of e.props) {
          if (pr.spread) continue; // best-effort: object spread not modelled
          if (pr.kind === 'get' || pr.kind === 'set') { accessors.push(pr); continue; }
          if (pr.computed && pr.keyNode) this.compileExpr(fe, pr.keyNode);
          else fe.emit(OP.PUSH_CONST, this.constId(String(pr.key)));
          this.compileExpr(fe, pr.value);
          n++;
        }
        fe.emit(OP.NEW_OBJ, n);
        // install getters/setters on the freshly-built object via a host call
        for (const acc of accessors) {
          fe.emit(OP.DUP);
          fe.emit(OP.PUSH_CONST, this.constId(String(acc.key)));
          fe.emit(OP.PUSH_CONST, this.constId(acc.kind));
          this.compileExpr(fe, acc.value);
          fe.emit(OP.CALL_HOST, this.hostId('__defaccessor'), 4);
          fe.emit(OP.POP);
        }
        break;
      }
      case 'New': {
        this.compileExpr(fe, e.callee);
        for (const a of e.args) this.compileExpr(fe, a);
        fe.emit(OP.CALL_HOST, this.hostId('__new'), e.args.length + 1);
        break;
      }
      case 'Class': {
        const props = [
          { key: '__isClass', value: { type: 'Bool', value: true } },
          { key: '__name', value: { type: 'Str', value: e.name || '' } },
          { key: '__super', value: e.superClass || { type: 'Null' } },
        ];
        const methods = [];
        for (const m of e.members) {
          if (m.computed) continue; // best-effort: computed member skipped
          if (m.key === 'constructor') props.push({ key: '__ctor', value: m.value });
          else methods.push({ key: m.key, value: m.value });
        }
        props.push({ key: '__methods', value: { type: 'Object', props: methods } });
        this.compileExpr(fe, { type: 'Object', props });
        break;
      }
      case 'Super': fe.emit(OP.PUSH_NULL); break;      // best-effort placeholder
      case 'Spread': this.compileExpr(fe, e.arg); break; // best-effort: flattened to one value
      case 'Yield': this.compileExpr(fe, e.arg); fe.emit(OP.YIELD); break; // append to the frame's yield list; leaves null
      case 'Index': {
        this.compileExpr(fe, e.object);
        this.compileExpr(fe, e.index);
        fe.emit(OP.ARR_GET);
        break;
      }
      case 'Member': {
        this.compileExpr(fe, e.object);
        fe.emit(OP.PUSH_CONST, this.constId(e.property));
        fe.emit(OP.ARR_GET);
        break;
      }
      case 'Unary': {
        switch (e.op) {
          case '-': this.compileExpr(fe, e.arg); fe.emit(OP.NEG); break;
          case '!': this.compileExpr(fe, e.arg); fe.emit(OP.NOT); break;
          case '+': this.compileExpr(fe, e.arg); fe.emit(OP.CALL_HOST, this.hostId('num'), 1); break;
          case '~': this.compileExpr(fe, e.arg); fe.emit(OP.CALL_HOST, this.hostId('bitnot'), 1); break;
          case 'typeof': this.compileExpr(fe, e.arg); fe.emit(OP.CALL_HOST, this.hostId('typeof'), 1); break;
          case 'void': this.compileExpr(fe, e.arg); fe.emit(OP.POP); fe.emit(OP.PUSH_NULL); break;
          case 'delete': this.compileExpr(fe, e.arg); fe.emit(OP.POP); fe.emit(OP.PUSH_TRUE); break;
          default: this.compileExpr(fe, e.arg); fe.emit(OP.NOT); break;
        }
        break;
      }
      case 'Await': {
        this.compileExpr(fe, e.arg);
        fe.emit(OP.AWAIT);
        break;
      }
      case 'Binary': {
        if (e.op === '&&' || e.op === '||') { this.compileLogical(fe, e); break; }
        if (e.op === '??') { this.compileLogical(fe, { op: '||', left: e.left, right: e.right }); break; } // best-effort
        if (e.op === '**' || e.op === 'instanceof' || e.op === 'in') {
          this.compileExpr(fe, e.left);
          this.compileExpr(fe, e.right);
          const h = e.op === '**' ? 'pow' : e.op === 'instanceof' ? 'instanceof' : 'inop';
          fe.emit(OP.CALL_HOST, this.hostId(h), 2);
          break;
        }
        this.compileExpr(fe, e.left);
        this.compileExpr(fe, e.right);
        fe.emit(this.binOp(e.op));
        break;
      }
      case 'Ternary': {
        this.compileExpr(fe, e.test);
        const lElse = fe.label();
        const lEnd = fe.label();
        fe.emit(OP.JZ, lElse);
        this.compileExpr(fe, e.cons);
        fe.emit(OP.JMP, lEnd);
        fe.mark(lElse);
        this.compileExpr(fe, e.alt);
        fe.mark(lEnd);
        break;
      }
      case 'Call': this.compileCall(fe, e); break;
      case 'Assign': {
        // assignment used in expression position (e.g. `++count`, `a = b = c`);
        // leaves the assigned value on the stack.
        const t = e.target;
        if (t.type === 'Ident') {
          if (this.isGlobalName(fe, t.name)) { this.emitGlobalSet(fe, t.name, e.value, true); }
          else { this.compileExpr(fe, e.value); fe.emit(OP.DUP); this.emitStore(fe, t.name); }
        } else if (t.type === 'Index') {
          this.compileExpr(fe, t.object); this.compileExpr(fe, t.index); this.compileExpr(fe, e.value); fe.emit(OP.ARR_SET);
        } else if (t.type === 'Member') {
          this.compileExpr(fe, t.object); fe.emit(OP.PUSH_CONST, this.constId(t.property)); this.compileExpr(fe, e.value); fe.emit(OP.ARR_SET);
        } else throw new Error('Invalid assignment target');
        break;
      }
      default:
        throw new Error(`Unknown expression ${e.type}`);
    }
  }

  compileCall(fe, e) {
    const callee = e.callee;

    // console.log(...) -> PRINT (kept as a built-in convenience for .js input)
    if (callee.type === 'Member' && callee.object.type === 'Ident'
        && callee.object.name === 'console' && callee.property === 'log'
        && fe.resolve('console').kind === 'none') {
      this.compileConsoleLog(fe, e.args);
      fe.emit(OP.PUSH_NULL);
      return;
    }

    // method call obj.m(args) -> load the property as the callee value, CALL_VALUE
    if (callee.type === 'Member') {
      // method call: preserve receiver under the callee so CALL_METHOD can bind `this`
      this.compileExpr(fe, callee.object);
      fe.emit(OP.DUP);
      fe.emit(OP.PUSH_CONST, this.constId(callee.property));
      fe.emit(OP.ARR_GET);
      for (const a of e.args) this.compileExpr(fe, a);
      fe.emit(OP.CALL_METHOD, e.args.length);
      return;
    }

    if (callee.type === 'Ident') {
      const name = callee.name;
      const r = fe.resolve(name);
      if (r.kind === 'local' || r.kind === 'upval') {
        // a variable holding a closure value
        this.compileExpr(fe, callee);
        for (const a of e.args) this.compileExpr(fe, a);
        fe.emit(OP.CALL_VALUE, e.args.length);
        return;
      }
      if (this.fnIndex.has(name)) {
        for (const a of e.args) this.compileExpr(fe, a);
        fe.emit(OP.CALL, this.fnIndex.get(name), e.args.length);
        return;
      }
      if (HOST_BUILTINS.has(name)) {
        for (const a of e.args) this.compileExpr(fe, a);
        fe.emit(OP.CALL_HOST, this.hostId(name), e.args.length);
        return;
      }
      // Unknown bare identifier call (e.g. `Number(x)`, `require(m)`, `Error(e)`):
      // resolve the name through the global environment and call the value. This
      // reaches host globals and module-scope functions rather than assuming a
      // built-in, and mirrors how an unknown identifier read resolves.
      fe.emit(OP.PUSH_CONST, this.constId(name));
      fe.emit(OP.CALL_HOST, this.hostId('__getglobal'), 1);
      for (const a of e.args) this.compileExpr(fe, a);
      fe.emit(OP.CALL_VALUE, e.args.length);
      return;
    }

    // callee is an arbitrary expression, e.g. (fn(){...})() or arr[i]()
    this.compileExpr(fe, callee);
    for (const a of e.args) this.compileExpr(fe, a);
    fe.emit(OP.CALL_VALUE, e.args.length);
  }

  compileConsoleLog(fe, args) {
    if (args.length === 0) {
      fe.emit(OP.PUSH_CONST, this.constId(''));
      fe.emit(OP.PRINT);
      return;
    }
    this.compileExpr(fe, args[0]);
    for (let i = 1; i < args.length; i++) {
      fe.emit(OP.PUSH_CONST, this.constId(' '));
      fe.emit(OP.ADD);
      this.compileExpr(fe, args[i]);
      fe.emit(OP.ADD);
    }
    fe.emit(OP.PRINT);
  }

  compileLogical(fe, e) {
    const done = fe.label();
    const shortLbl = fe.label();
    if (e.op === '&&') {
      this.compileExpr(fe, e.left);
      fe.emit(OP.JZ, shortLbl);
      this.compileExpr(fe, e.right);
      fe.emit(OP.JZ, shortLbl);
      fe.emit(OP.PUSH_TRUE);
      fe.emit(OP.JMP, done);
      fe.mark(shortLbl);
      fe.emit(OP.PUSH_FALSE);
      fe.mark(done);
    } else { // ||
      this.compileExpr(fe, e.left);
      fe.emit(OP.JNZ, shortLbl);
      this.compileExpr(fe, e.right);
      fe.emit(OP.JNZ, shortLbl);
      fe.emit(OP.PUSH_FALSE);
      fe.emit(OP.JMP, done);
      fe.mark(shortLbl);
      fe.emit(OP.PUSH_TRUE);
      fe.mark(done);
    }
  }

  binOp(op) {
    switch (op) {
      case '+': return OP.ADD; case '-': return OP.SUB; case '*': return OP.MUL;
      case '/': return OP.DIV; case '%': return OP.MOD;
      case '===': return OP.EQ; case '!==': return OP.NEQ; case '==': return OP.EQ; case '!=': return OP.NEQ;
      case '<': return OP.LT; case '>': return OP.GT; case '<=': return OP.LTE; case '>=': return OP.GTE;
      case '&': return OP.BAND; case '|': return OP.BOR; case '^': return OP.BXOR;
      case '<<': return OP.SHL; case '>>': return OP.SHR; case '>>>': return OP.SHR;
      default: throw new Error(`Unknown binary operator ${op}`);
    }
  }
}

function compile(src, opts = {}) {
  // resolve `import "..."` modules before lexing (a no-op when there are none)
  if (opts.resolveImport || hasImports(src)) src = expandImports(src, opts.resolveImport);
  let ast = parse(src);
  if (opts.optimize) ast = optimize(ast); // behavior-preserving AST optimization
  // Global string encryption runs AFTER optimization (so constant folding can't
  // re-collapse the reconstructed literals) but before codegen. `tree` mode uses
  // the shared-blob extrapolation; other modes encrypt each literal in place.
  if (opts.encStr === 'tree') ast = treeMapStrings(ast, 'tree', opts.seed);
  if ((opts.encStr && opts.encStr !== 'none' && opts.encStr !== 'tree') || opts.encNum) ast = encryptStrings(ast, opts.encStr === 'tree' ? 'none' : opts.encStr, opts.seed, opts.encNum);
  const c = new Compiler({ fuse: opts.fuse, useEnvObjects: !!opts.useEnvObjects, seed: opts.seed, globalProt: opts.globalProt, perFnProt: opts.perFnProt });
  const program = c.compileProgram(ast);
  program.encStrCount = (ast._encStrCount || 0) + (ast._treeCount || 0);
  program.encNumCount = ast._encNumCount || 0;
  program.treeCount = ast._treeCount || 0;
  program.upvalueMode = c.useEnvObjects ? 'env' : 'cells';
  return program;
}

module.exports = { compile, HOST_BUILTINS };
