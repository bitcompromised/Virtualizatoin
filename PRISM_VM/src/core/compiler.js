'use strict';
// AST -> Prism image. A compact compiler for the Phase-1 language subset:
// let/const, numbers/strings/booleans/null, arithmetic & comparison & logical
// operators, if/else, while, ternary, top-level functions with parameters &
// recursion, console.log / print. Unsupported constructs throw a clear error --
// the subset grows in later phases; the pipeline around it is the point.
//
// Reuses vm-gen's proven lexer + parser (src/frontend); the compiler consumes a
// subset of that AST and targets the opcode spec (src/core/spec.js).

const { lex } = require('../frontend/lexer');
const { parse } = require('../frontend/parser');
const { OP, OPS, opWidth } = require('./spec');
const { makeRng } = require('./rng');
const { LBL, peepholeClean, bogusStack, runPipeline } = require('./passes');
const { expandDirectives } = require('./directives');
const { makeArithDecoy } = require('./decoys');
const { parsePragmas, mergeOpts } = require('./pragma');

// Bare-name host builtins (also reachable as Math.<name>) bridged via CALL_HOST.
const HOST_BUILTINS = new Set(['floor', 'ceil', 'round', 'abs', 'sqrt', 'pow', 'min', 'max', 'num', 'str']);

function unsupported(node) {
  throw new Error(`Prism (slice): unsupported ${node && node.type ? node.type : node} `
    + `-- this construct is not in the Phase-1 subset yet`);
}

class FnScope {
  constructor(name, params, parent) {
    this.name = name;
    this.nparams = params.length;
    this.slots = new Map();
    params.forEach((p, i) => this.slots.set(p, i));
    this.next = params.length;
    this.instrs = [];
    this.parent = parent || null;
    this.upvals = [];               // [{ name, fromLocal, index }]
    this.upvalMap = new Map();      // name -> upval index
  }
  slot(name, create) {
    if (this.slots.has(name)) return this.slots.get(name);
    if (!create) return -1;
    const s = this.next++;
    this.slots.set(name, s);
    return s;
  }
  // Resolve a free variable to an upvalue index in THIS scope, adding upvalue
  // links up the enclosing chain as needed (standard closure conversion).
  resolveUpval(name) {
    if (this.upvalMap.has(name)) return this.upvalMap.get(name);
    if (!this.parent) return -1;
    if (this.parent.slots.has(name)) return this.addUpval(name, true, this.parent.slots.get(name));
    const up = this.parent.resolveUpval(name);
    if (up >= 0) return this.addUpval(name, false, up);
    return -1;
  }
  addUpval(name, fromLocal, index) {
    const i = this.upvals.length;
    this.upvals.push({ name, fromLocal, index });
    this.upvalMap.set(name, i);
    return i;
  }
  emit(op, ...args) { this.instrs.push({ op, args }); }
  label() { return {}; }
  here(l) { this.instrs.push({ op: LBL, label: l }); }
}

function compile(source, opts = {}) {
  if (opts.resolveImport) { /* imports not in slice */ }
  // inline `<@protect ...>` pragmas set build defaults from the source itself;
  // explicit opts still win. The resolved options are stamped on the image so the
  // API/CLI honor an inline `backend=`, `encrypt`, etc. without re-parsing.
  const pr = parsePragmas(source);
  opts = mergeOpts(pr.opts, opts);
  source = pr.source;
  // directive plugins expand surface syntax before parsing
  if (Array.isArray(opts.plugins)) source = expandDirectives(source, opts.plugins.filter((p) => p && p.kind === 'directive'));
  const ast = parse(source);

  // pre-pass: register top-level function names (calls may be forward refs)
  const fnIndex = new Map(); // name -> index
  const fnDecls = [];
  fnIndex.set('$main', 0);
  const topStmts = [];
  for (const s of ast.body) {
    if (s.type === 'FnDecl') { fnIndex.set(s.name, fnDecls.length + 1); fnDecls.push(s); }
    else topStmts.push(s);
  }

  const consts = [];
  const constKey = new Map();
  const constId = (v) => {
    const k = (typeof v) + ':' + String(v);
    if (constKey.has(k)) return constKey.get(k);
    const id = consts.length; consts.push(v); constKey.set(k, id); return id;
  };

  // Assemble the pass pipeline from options: built-in optimize/obfuscate passes
  // plus any custom `kind:'pass'` plugins. Seeded for reproducibility.
  const seed = (opts.seed !== undefined ? opts.seed : 0x50415254) >>> 0;
  const rng = makeRng(seed);
  const passes = [];
  if (opts.optimize !== false) passes.push(peepholeClean);
  const bogusLevel = (opts.protect && opts.protect.bogus) ? opts.protect.bogus : 0;
  if (bogusLevel) passes.push(bogusStack(bogusLevel));
  if (Array.isArray(opts.plugins)) for (const p of opts.plugins) if (p && p.kind === 'pass') passes.push(p);
  const passCtx = { rng, constId, OP, OPS, opWidth, consts };

  const functions = [];

  function compileFn(name, params, body, parent) {
    const fn = new FnScope(name, params, parent || null);
    for (const st of body) compileStmt(fn, st);
    fn.emit(OP.PUSH_NULL); fn.emit(OP.RET); // implicit `return null` fallthrough
    return finalizeFn(fn);
  }
  function finalizeFn(fn) {
    if (passes.length) runPipeline(fn, passes, passCtx);
    return finish(fn);
  }
  // Compile a nested function (expression or declaration) into the flat function
  // table, returning its index; the caller emits CLOSURE for it.
  function compileFnExpr(parent, node) {
    const idx = functions.length;
    functions.push(null); // reserve slot (so recursion / ordering is stable)
    functions[idx] = compileFn(node.name || '$anon', node.params, node.body.body, parent);
    return idx;
  }

  function finish(fn) {
    // pass 1: assign each label marker its byte offset (markers have width 0)
    let off = 0;
    for (const ins of fn.instrs) {
      if (ins.op === LBL) { ins.label.off = off; continue; }
      off += opWidth(ins.op);
    }
    // pass 2: emit bytes, resolving label-object operands to their offset
    const code = [];
    for (const ins of fn.instrs) {
      if (ins.op === LBL) continue;
      code.push(ins.op);
      const kinds = OPS[ins.op].operands;
      for (let a = 0; a < kinds.length; a++) {
        let v = ins.args[a];
        if (v && typeof v === 'object') v = v.off; // label marker -> resolved offset
        if (kinds[a] === 'u16') { code.push(v & 0xff, (v >>> 8) & 0xff); }
        else code.push(v & 0xff);
      }
    }
    return { name: fn.name, nparams: fn.nparams, nlocals: fn.next, code, upvals: fn.upvals.map((u) => ({ fromLocal: u.fromLocal, index: u.index })) };
  }

  // resolve a name for READ: local -> LOAD, upvalue -> LOAD_UPVAL, top-level fn
  // -> CLOSURE (as a value). Returns false if the name is unknown.
  function loadName(fn, name) {
    const slot = fn.slot(name, false);
    if (slot >= 0) { fn.emit(OP.LOAD, slot); return true; }
    const up = fn.resolveUpval(name);
    if (up >= 0) { fn.emit(OP.LOAD_UPVAL, up); return true; }
    if (fnIndex.has(name)) { fn.emit(OP.CLOSURE, fnIndex.get(name)); return true; }
    return false;
  }
  // resolve a name for WRITE (value already on stack): upvalue -> STORE_UPVAL,
  // else a local (created if new).
  function storeName(fn, name) {
    if (fn.slot(name, false) < 0) {
      const up = fn.resolveUpval(name);
      if (up >= 0) { fn.emit(OP.STORE_UPVAL, up); return; }
    }
    fn.emit(OP.STORE, fn.slot(name, true));
  }

  // ---- statements ----
  function compileStmt(fn, s) {
    switch (s.type) {
      case 'Let': {
        const slot = fn.slot(s.name, true);
        if (s.value) { compileExpr(fn, s.value); fn.emit(OP.STORE, slot); }
        return;
      }
      case 'Seq': { for (const b of s.body) compileStmt(fn, b); return; }
      case 'Block': { for (const b of s.body) compileStmt(fn, b); return; }
      case 'Return': {
        if (s.value) compileExpr(fn, s.value); else fn.emit(OP.PUSH_NULL);
        fn.emit(OP.RET); return;
      }
      case 'Print': { compileExpr(fn, s.value); fn.emit(OP.PRINT); return; }
      case 'If': {
        const elseL = fn.label(), endL = fn.label();
        compileExpr(fn, s.test); fn.emit(OP.JZ, elseL);
        compileStmt(fn, s.cons);
        if (s.alt) { fn.emit(OP.JMP, endL); fn.here(elseL); compileStmt(fn, s.alt); fn.here(endL); }
        else fn.here(elseL);
        return;
      }
      case 'While': {
        const startL = fn.label(), endL = fn.label();
        fn.here(startL);
        compileExpr(fn, s.test); fn.emit(OP.JZ, endL);
        compileStmt(fn, s.body); fn.emit(OP.JMP, startL);
        fn.here(endL);
        return;
      }
      case 'Assign': {
        if (s.target.type === 'Index') {
          compileExpr(fn, s.target.object); compileExpr(fn, s.target.index); compileExpr(fn, s.value);
          fn.emit(OP.INDEX_SET); return;
        }
        if (s.target.type === 'Member') {
          compileExpr(fn, s.target.object); fn.emit(OP.PUSH_CONST, constId(s.target.property)); compileExpr(fn, s.value);
          fn.emit(OP.INDEX_SET); return;
        }
        if (s.target.type !== 'Ident') return unsupported(s);
        compileExpr(fn, s.value); storeName(fn, s.target.name); return;
      }
      case 'For': {
        if (s.init) compileStmt(fn, s.init);
        const startL = fn.label(), endL = fn.label();
        fn.here(startL);
        if (s.test) { compileExpr(fn, s.test); fn.emit(OP.JZ, endL); }
        compileStmt(fn, s.body);
        if (s.update) compileStmt(fn, s.update);
        fn.emit(OP.JMP, startL);
        fn.here(endL);
        return;
      }
      case 'Call': { compileExpr(fn, s); fn.emit(OP.POP); return; } // bare call statement
      case 'ExprStmt': { compileExprStmt(fn, s.expr); return; }
      case 'FnDecl': {
        // nested function declaration -> a closure bound to a local (name slot
        // allocated first so the body can capture it for recursion).
        const slot = fn.slot(s.name, true);
        const idx = compileFnExpr(fn, { name: s.name, params: s.params, body: s.body });
        fn.emit(OP.CLOSURE, idx); fn.emit(OP.STORE, slot); return;
      }
      default: return unsupported(s);
    }
  }

  // expression in statement position: the value it produces is unused, so it
  // must be discarded. Every compileExpr leaves exactly one value on the stack,
  // so a bare expression statement always POPs one -- otherwise the leftover
  // corrupts an enclosing computation (e.g. a postfix `i++` in a for-update,
  // which desugars to `(i = i+1) - 1`, would leak its old value every iteration).
  function compileExprStmt(fn, e) {
    // Fast path: `x = v;` stores directly (STORE pops), leaving nothing behind.
    if (e.type === 'Assign' && e.target.type === 'Ident') {
      compileExpr(fn, e.value); storeName(fn, e.target.name); return;
    }
    compileExpr(fn, e);
    fn.emit(OP.POP);
  }

  // ---- expressions ----
  function compileExpr(fn, e) {
    switch (e.type) {
      case 'Num': fn.emit(OP.PUSH_CONST, constId(e.value)); return;
      case 'Str': fn.emit(OP.PUSH_CONST, constId(e.value)); return;
      case 'Bool': fn.emit(e.value ? OP.PUSH_TRUE : OP.PUSH_FALSE); return;
      case 'Null': fn.emit(OP.PUSH_NULL); return;
      case 'Ident': {
        if (loadName(fn, e.name)) return;
        return unsupported({ type: `reference to '${e.name}' (unknown identifier)` });
      }
      case 'FnExpr': {
        const idx = compileFnExpr(fn, { name: e.name, params: e.params, body: e.body });
        fn.emit(OP.CLOSURE, idx); return;
      }
      case 'Assign': {
        if (e.target.type !== 'Ident') return unsupported(e);
        compileExpr(fn, e.value); fn.emit(OP.DUP); storeName(fn, e.target.name); return;
      }
      case 'Unary': {
        compileExpr(fn, e.arg);
        if (e.op === '-') fn.emit(OP.NEG);
        else if (e.op === '!') fn.emit(OP.NOT);
        else return unsupported(e);
        return;
      }
      case 'Binary': return compileBinary(fn, e);
      case 'Ternary': {
        const elseL = fn.label(), endL = fn.label();
        compileExpr(fn, e.test); fn.emit(OP.JZ, elseL);
        compileExpr(fn, e.cons); fn.emit(OP.JMP, endL);
        fn.here(elseL); compileExpr(fn, e.alt); fn.here(endL); return;
      }
      case 'Array': {
        for (const el of e.elements) compileExpr(fn, el);
        fn.emit(OP.NEW_ARRAY, e.elements.length); return;
      }
      case 'Object': {
        for (const pr of e.props) {
          if (pr.computed) compileExpr(fn, pr.keyNode); else fn.emit(OP.PUSH_CONST, constId(pr.key));
          compileExpr(fn, pr.value);
        }
        fn.emit(OP.NEW_OBJECT, e.props.length); return;
      }
      case 'Index': {
        compileExpr(fn, e.object); compileExpr(fn, e.index); fn.emit(OP.INDEX_GET); return;
      }
      case 'Member': {
        if (e.property === 'length') { compileExpr(fn, e.object); fn.emit(OP.LEN); return; }
        compileExpr(fn, e.object); fn.emit(OP.PUSH_CONST, constId(e.property)); fn.emit(OP.INDEX_GET); return;
      }
      case 'Call': return compileCall(fn, e);
      default: return unsupported(e);
    }
  }

  const BINOP = { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD,
    '==': OP.EQ, '===': OP.EQ, '!=': OP.NE, '!==': OP.NE, '<': OP.LT, '>': OP.GT, '<=': OP.LE, '>=': OP.GE };

  function compileBinary(fn, e) {
    if (e.op === '&&' || e.op === '||') {
      const endL = fn.label();
      compileExpr(fn, e.left); fn.emit(OP.DUP);
      fn.emit(e.op === '&&' ? OP.JZ : OP.JNZ, endL);
      fn.emit(OP.POP); compileExpr(fn, e.right);
      fn.here(endL); return;
    }
    const op = BINOP[e.op];
    if (op === undefined) return unsupported({ type: `binary '${e.op}'` });
    compileExpr(fn, e.left); compileExpr(fn, e.right); fn.emit(op);
  }

  function compileCall(fn, e) {
    // console.log(...) / print(...) -> PRINT (args space-joined)
    const c = e.callee;
    const isConsole = c.type === 'Member' && c.object.type === 'Ident' && c.object.name === 'console'
      && (c.property === 'log' || c.property === 'info' || c.property === 'warn');
    const isPrint = c.type === 'Ident' && c.property === undefined && (c.name === 'print');
    if (isConsole || isPrint) {
      if (e.args.length === 0) { fn.emit(OP.PUSH_CONST, constId('')); }
      else {
        compileExpr(fn, e.args[0]);
        for (let i = 1; i < e.args.length; i++) {
          fn.emit(OP.PUSH_CONST, constId(' ')); fn.emit(OP.ADD);
          compileExpr(fn, e.args[i]); fn.emit(OP.ADD);
        }
      }
      fn.emit(OP.PRINT);
      fn.emit(OP.PUSH_NULL); // calls are expressions; leave a value
      return;
    }
    // len(x) builtin -> LEN opcode (works on arrays and strings)
    if (c.type === 'Ident' && c.name === 'len' && e.args.length === 1 && !fnIndex.has('len')) {
      compileExpr(fn, e.args[0]); fn.emit(OP.LEN); return;
    }
    // Math.X(...) or a bare host builtin -> CALL_HOST
    let hostName = null;
    if (c.type === 'Member' && c.object.type === 'Ident' && c.object.name === 'Math') hostName = c.property;
    else if (c.type === 'Ident' && HOST_BUILTINS.has(c.name) && !fnIndex.has(c.name) && fn.slot(c.name, false) < 0) hostName = c.name;
    if (hostName) {
      for (const a of e.args) compileExpr(fn, a);
      fn.emit(OP.CALL_HOST, constId(hostName), e.args.length);
      return;
    }
    // top-level function by name -> direct CALL (fast path), unless a local/upval
    // shadows it (then it's a closure value).
    if (c.type === 'Ident' && fnIndex.has(c.name) && fn.slot(c.name, false) < 0 && fn.resolveUpval(c.name) < 0) {
      for (const a of e.args) compileExpr(fn, a);
      fn.emit(OP.CALL, fnIndex.get(c.name), e.args.length);
      return;
    }
    // otherwise: a value call -- a closure held in a local/upval, returned from a
    // call, an IIFE, or stored on an object/array.
    compileExpr(fn, c);
    for (const a of e.args) compileExpr(fn, a);
    fn.emit(OP.CALL_VALUE, e.args.length);
  }

  // Pre-reserve slots 0..N for main + every top-level function, so nested
  // functions compiled inside them (compileFnExpr appends at functions.length)
  // get indices ABOVE the reserved range instead of colliding with them.
  for (let i = 0; i <= fnDecls.length; i++) functions.push(null);
  // main = function 0
  functions[0] = compileFn('$main', [], topStmts);
  for (let i = 0; i < fnDecls.length; i++) {
    const d = fnDecls[i];
    functions[fnIndex.get(d.name)] = compileFn(d.name, d.params, d.body.body);
  }

  // Decoys: append never-referenced functions to the table. No real instruction
  // targets these indices, so they are unreachable and output-neutral -- the
  // conformance gate proves it. `kind:'decoy'` plugins (built-in + any supplied
  // in opts.plugins) supply the bodies; `protect.decoys` sets the count/strength.
  const decoyReq = (opts.protect && opts.protect.decoys) ? opts.protect.decoys : 0;
  if (decoyReq > 0) {
    const strength = (opts.protect && opts.protect.decoyStrength) || Math.min(3, decoyReq);
    const custom = Array.isArray(opts.plugins) ? opts.plugins.filter((p) => p && p.kind === 'decoy') : [];
    const gens = custom.length ? custom : [makeArithDecoy(strength)];
    const decoyCtx = { rng, constId, OP };
    for (let d = 0; d < decoyReq; d++) {
      const gen = gens[d % gens.length];
      const params = [];
      const pn = rng() % 3; for (let p = 0; p < pn; p++) params.push('a' + p);
      const fn = new FnScope(gen.name || '$decoy', params, null);
      gen.generate(fn, decoyCtx);
      functions.push(finish(fn));
    }
  }

  return { consts, functions, entry: 0, opts };
}

module.exports = { compile, lex, parse };
