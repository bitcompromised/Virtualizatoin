'use strict';
// Reference interpreter (behavioral oracle).
//
// Runs a *canonical* compiled program (the output of compiler.compile) directly,
// with no opcode permutation, encryption, checksums or polymorphism. Its only
// job is to be obviously correct and easy to inspect, so that generated /
// protected VMs can be validated against it (see test/run.js) and so that the
// compiler and optimizer can be debugged without any protection in the way.
//
// It optionally records a full execution trace (step, opcode, stack, locals).

const { OP_NAME, OP_OPERANDS } = require('./opcodes');

const OP = {};
OP_NAME.forEach((n, i) => { OP[n] = i; });

function operandBytes(op) {
  let n = 1;
  for (const k of OP_OPERANDS[op]) n += k === 'u16' ? 2 : 1;
  return n;
}

// Map each instruction's byte offset within a function to its instruction index,
// so byte-offset jump targets (as produced by the compiler) can be followed.
function offsetMap(fn) {
  const map = Object.create(null);
  let off = 0;
  for (let i = 0; i < fn.instrs.length; i++) {
    map[off] = i;
    off += operandBytes(fn.instrs[i].op);
  }
  map[off] = fn.instrs.length;
  return map;
}

// ---- runtime value model (see docs/VALUE-MODEL.md) ----
// number | string | boolean | null | Array | VMObj (map) | closure | cell
class VMObj {
  constructor(proto = null) { this.keys = []; this.map = Object.create(null); this.proto = proto || null; this.__heapId = null; }
  get(k) { k = String(k); if (k in this.map) return this.map[k]; if (this.proto && typeof this.proto.get === 'function') return this.proto.get(k); return null; }
  set(k, v) { k = String(k); if (!(k in this.map)) this.keys.push(k); this.map[k] = v; }
  has(k) { return String(k) in this.map || (this.proto && this.proto.has && this.proto.has(k)); }
  // Serialize as a plain object (for JSON.stringify and native consumers).
  toJSON() { const o = {}; for (const k of this.keys) o[k] = this.map[k]; return o; }
}
const isObj = (v) => v instanceof VMObj;
const isClosure = (v) => !!v && typeof v === 'object' && v.__closure === true;
// heap-allocated cells and objects go here; GC marks/sweeps this array
const heap = [];
let allocCount = 0;
function alloc(obj) { obj.__heapId = heap.length; heap.push({ obj, marked: false }); allocCount++; if (allocCount % 256 === 0) gc(); return obj; }
const mkCells = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = alloc({ v: null }); return a; };

// -- GC: simple mark-and-sweep --
function markValue(v) {
  if (v === null || v === undefined) return;
  if (typeof v === 'object') {
    // heap-allocated objects carry __heapId set by alloc
    if (v.__heapId != null) {
      const entry = heap[v.__heapId];
      if (!entry || entry.marked) return;
      entry.marked = true;
      const o = entry.obj;
      // traverse internals depending on shape
      if (o instanceof VMObj || (o && o.keys && o.map)) {
        for (const k of (o.keys || [])) markValue(o.map[k]);
        if (o.proto) markValue(o.proto);
      } else if (Array.isArray(o)) {
        for (const el of o) markValue(el);
      } else if (o && typeof o === 'object') {
        // cell {v: ...} or generic allocated object
        for (const kk in o) markValue(o[kk]);
      }
      return;
    }
    // not heap-allocated: still descend to find heap-allocated children
    if (Array.isArray(v)) { for (const el of v) markValue(el); return; }
    if (isClosure(v)) {
      if (Array.isArray(v.upvals)) for (const c of v.upvals) markValue(c);
      else if (v.upvals && v.upvals.cells) for (const c of v.upvals.cells) markValue(c);
      else if (v.upvals && v.upvals.env) markValue(v.upvals.env);
      return;
    }
    if (isObj(v)) {
      for (const k of v.keys) markValue(v.map[k]);
      if (v.proto) markValue(v.proto);
      return;
    }
    // generic object
    for (const kk in v) markValue(v[kk]);
  }
}

function gc() {
  // guard if interpreter state isn't present (alloc may be used outside interpret during init)
  if (typeof stack === 'undefined' || typeof frames === 'undefined' || typeof consts === 'undefined' || typeof handlers === 'undefined' || typeof frame === 'undefined') return;
  // mark phase: roots are stack, frames' locals/upvals, consts, and handler metadata
  for (let i = 0; i < heap.length; i++) if (heap[i]) heap[i].marked = false;
  // roots
  for (const v of stack) markValue(v);
  if (frame) {
    markValue(frame.locals);
    markValue(frame.upvals);
  }
  for (const fr of frames) { if (fr) { markValue(fr.locals); markValue(fr.upvals); } }
  for (const c of consts) markValue(c);
  for (const h of handlers) markValue(h);
  // sweep
  for (let i = 0; i < heap.length; i++) {
    const e = heap[i];
    if (!e) continue;
    if (!e.marked) {
      // free: clear object's __heapId so dangling refs won't confuse later marking
      try { if (e.obj && e.obj.__heapId != null) e.obj.__heapId = null; } catch (e2) {}
      heap[i] = null;
    } else {
      e.marked = false; // reset for next GC
    }
  }
}

function toStr(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return '[' + v.map(toStr).join(', ') + ']';
  if (isObj(v)) return '{' + v.keys.map((k) => k + ': ' + toStr(v.map[k])).join(', ') + '}';
  if (isClosure(v)) return '<fn ' + (v.fn != null ? v.fn : '?') + '>';
  if (v && typeof v === 'object' && v.__promise) return '<promise ' + (v.resolved !== undefined ? 'resolved' : v.rejected ? 'rejected' : 'pending') + '>';
  return String(v);
}
function truthy(v) { return !(v === null || v === undefined || v === false || v === 0 || v === ''); }
function u32(n) { return n >>> 0; }

function host(name, args) {
  switch (name) {
    case 'len':
      if (Array.isArray(args[0])) return args[0].length;
      if (isObj(args[0])) return args[0].keys.length;
      return String(args[0]).length;
    case 'str': return toStr(args[0]);
    case 'num': return parseFloat(args[0]);
    case 'floor': return Math.floor(args[0]);
    case 'abs': return Math.abs(args[0]);
    case 'rand': return Math.random();
    case 'time': return Date.now();
    case 'push': args[0].push(args[1]); return args[0];
    case 'keys': return isObj(args[0]) ? args[0].keys.slice() : [];
    case 'has': return isObj(args[0]) ? args[0].has(args[1]) : false;
    default: throw new Error('unknown host builtin ' + name);
  }
}

function index(obj, key) {
  if (isObj(obj)) return obj.get(key);
  if (obj === null || obj === undefined) throw new Error('cannot index ' + toStr(obj));
  return obj[key]; // arrays, strings, and native objects/functions/numbers
}
function indexSet(obj, key, val) {
  if (isObj(obj)) { obj.set(key, val); return; }
  if (obj && (typeof obj === 'object' || typeof obj === 'function')) { obj[key] = val; return; }
  throw new Error('cannot assign index of ' + toStr(obj));
}

// Interpret a canonical program.
//   opts.trace     collect a per-step trace (array of records)
//   opts.maxSteps  abort after this many instructions (0 = unlimited)
// Returns { output: string[], steps, returnValue, trace }.
// Only an explicit THROW is catchable; other runtime errors abort the VM.
const { hostGlobalTable, makeRequire } = require('./hostenv');

async function interpret(program, opts = {}) {
  const { functions: fns, consts } = program;
  const maxSteps = opts.maxSteps || 0;
  const output = [];
  // Shared global environment: module-scope `let`s live here, and unresolved
  // names fall through to the host global table.
  const globals = Object.create(null);
  const hostGlobals = hostGlobalTable();
  const requireBridge = makeRequire(opts.dir || process.cwd());
  const trace = opts.trace ? [] : null;
  const maps = fns.map(offsetMap);

  const stack = [];
  const frames = [];
  const handlers = []; // { fnIdx, frame, framesLen, stackLen, addr, meta }
  let frame = { idx: 0, fn: fns[0], i: 0, locals: mkCells(fns[0].nlocals), upvals: [] };
  let steps = 0;

  // Event-loop primitives: microtask queue (promise reactions) and macrotask queue (timers)
  const microtasks = [];
  const macrotasks = [];
  const pendingAsync = []; // spawned async-function promises awaited before HALT returns
  let drainingMicro = false;
  function scheduleMicro(fn) { microtasks.push(fn); }
  function scheduleMacro(fn) { macrotasks.push(fn); }
  function drainMicro() {
    if (drainingMicro) return;
    drainingMicro = true;
    try {
      while (microtasks.length) {
        const f = microtasks.shift();
        try { f(); } catch (err) {
          // exceptions in microtasks should be handled by VM's raise if possible
          try { if (!raise(err)) throw err; } catch (e) { throw e; }
        }
      }
    } finally { drainingMicro = false; }
  }
  // helper to process one macrotask (used by host timers if implemented)
  function runMacrotask() { const fn = macrotasks.shift(); if (fn) { try { fn(); } catch (err) { if (!raise(err)) throw err; } } }

  // Before the program returns, run the event loop to completion: drain
  // microtasks, run macrotasks, and await any spawned async-function promises
  // (and any real host promises they await), so async output is not lost.
  async function settleAll() {
    for (let guard = 0; guard < 100000; guard++) {
      let progressed = false;
      try { if (microtasks.length) { drainMicro(); progressed = true; } } catch (e) {}
      while (macrotasks.length) { runMacrotask(); progressed = true; }
      if (pendingAsync.length) { const ps = pendingAsync.splice(0); await Promise.allSettled(ps); progressed = true; }
      await Promise.resolve(); // yield a turn so awaited host promises settle
      if (!progressed && microtasks.length === 0 && macrotasks.length === 0 && pendingAsync.length === 0) break;
    }
  }


  // host builtins need access to current handlers for inspection
  function host(name, args) {
    switch (name) {
      case 'len':
        if (Array.isArray(args[0])) return args[0].length;
        if (isObj(args[0])) return args[0].keys.length;
        return String(args[0]).length;
      case 'str': return toStr(args[0]);
      case 'num': return parseFloat(args[0]);
      case 'floor': return Math.floor(args[0]);
      case 'abs': return Math.abs(args[0]);
      case 'rand': return Math.random();
      case 'time': return Date.now();
      case 'push': args[0].push(args[1]); return args[0];
      case 'keys': return isObj(args[0]) ? args[0].keys.slice() : [];
      case 'has': return isObj(args[0]) ? args[0].has(args[1]) : false;
      case 'handlers':
        // return a snapshot of the current handler stack for inspection
        return handlers.map((h) => ({ fn: fns[h.fnIdx].name, addr: h.addr, meta: h.meta }));
      case 'await':
        // trivial await helper (synchronous check) — prefer OP.AWAIT for true suspension.
        const p = args[0];
        if (p && typeof p === 'object' && p.__promise) {
          if (p.rejected) throw p.rejected;
          if (p.resolved !== undefined) return p.resolved;
          return null; // not settled yet
        }
        return args[0];
      case 'createProto': {
        const proto = args[0];
        const obj = alloc(new VMObj(proto));
        return obj;
      }
      // ---- global environment + JS interop ----
      case '__setglobal': globals[args[0]] = args[1]; return args[1];
      case '__getglobal': {
        const nm = args[0];
        if (Object.prototype.hasOwnProperty.call(globals, nm)) return globals[nm];
        if (nm === 'require') return requireBridge;
        if (Object.prototype.hasOwnProperty.call(hostGlobals, nm)) return hostGlobals[nm];
        return undefined;
      }
      case 'typeof': {
        const v = args[0];
        if (v === undefined) return 'undefined';
        if (v === null) return 'object';
        if (isClosure(v) || typeof v === 'function') return 'function';
        if (Array.isArray(v) || isObj(v)) return 'object';
        return typeof v;
      }
      case 'bitnot': return ~toNumeric(args[0]);
      case 'pow': return Math.pow(args[0], args[1]);
      case 'instanceof': return hostInstanceof(args[0], args[1]);
      case 'inop': {
        const k = args[0], o = args[1];
        if (isObj(o)) return o.has(k);
        if (Array.isArray(o)) return Number(k) >= 0 && Number(k) < o.length;
        if (o && typeof o === 'object') return k in o;
        return false;
      }
      case 'require': return requireBridge(args[0]);
      case '__new': return hostNew(args);
      case '__defaccessor': { const o = args[0]; if (isObj(o)) { if (args[2] === 'get') { (o.__getters || (o.__getters = {}))[args[1]] = args[3]; } else { (o.__setters || (o.__setters = {}))[args[1]] = args[3]; } } return o; }
      case '__regex': { try { return new RegExp(args[0], args[1] || ''); } catch (_) { return null; } }
      case '__extend': {
        const a = args[0], it = args[1];
        if (Array.isArray(it) || typeof it === 'string') { for (let i = 0; i < it.length; i++) a.push(it[i]); }
        else if (it && typeof Symbol !== 'undefined' && typeof it[Symbol.iterator] === 'function') { const iter = it[Symbol.iterator](); let st; while (!(st = iter.next()).done) a.push(st.value); }
        else if (isObj(it)) { for (const k of it.keys) a.push(it.get(k)); }
        return a;
      }
      default: throw new Error('unknown host builtin ' + name);
    }
  }

  function toNumeric(v) { const n = Number(v); return Number.isNaN(n) ? 0 : n; }

  function hostInstanceof(obj, ctor) {
    if (typeof ctor === 'function') { try { return obj instanceof ctor; } catch (_) { return false; } }
    if (isObj(ctor) && ctor.get('__isClass')) {
      let c = isObj(obj) ? obj.__classRef : null;
      while (c && isObj(c)) { if (c === ctor) return true; c = c.get('__super'); }
      return false;
    }
    return false;
  }

  // Construct either a VM class instance or a native object.
  function hostNew(args) {
    const cls = args[0]; const rest = args.slice(1);
    if (typeof cls === 'function') { try { return new cls(...rest); } catch (_) { return null; } }
    if (isObj(cls) && cls.get('__isClass')) {
      const inst = alloc(new VMObj());
      inst.__classRef = cls;
      const chain = []; let c = cls;
      while (c && isObj(c) && c.get('__isClass')) { chain.unshift(c); c = c.get('__super'); }
      for (const k of chain) { const m = k.get('__methods'); if (isObj(m)) for (const mk of m.keys) inst.set(mk, m.get(mk)); }
      let ctor = null;
      for (let idx = chain.length - 1; idx >= 0; idx--) { const cc = chain[idx].get('__ctor'); if (cc) { ctor = cc; break; } }
      if (ctor && isClosure(ctor)) { for (const a of rest) stack.push(a); runFrameSync(ctor.fn, rest.length, ctor.upvals, inst); }
      return inst;
    }
    return null;
  }

  // Wrap a VM closure as a real JS callable so it can be passed to native host
  // methods (Array.map, Promise.then, ...). Native code invokes it like any
  // function; we re-enter the VM synchronously to compute the result.
  // Run an async VM function and return a REAL JS promise for its result, so
  // `.then`/`.catch`/`.finally` and `await` are native operations. Tracked so it
  // is drained before the program returns.
  function spawnAsync(fnIdx, argc, upvals, thisObj) {
    const jsP = Promise.resolve(runFrameAsync(fnIdx, argc, upvals || [], thisObj != null ? thisObj : null));
    pendingAsync.push(jsP);
    jsP.catch(() => {}); // rejection is surfaced at the await point
    return jsP;
  }

  function toNative(v) {
    if (isClosure(v)) {
      const np = (fns[v.fn] && fns[v.fn].nparams) || 0;
      return function (...jsArgs) {
        const n = Math.min(jsArgs.length, np); // ignore extra native args (index, array, ...)
        for (let k = 0; k < n; k++) stack.push(jsArgs[k]);
        return runFrameSync(v.fn, n, v.upvals, this !== undefined ? this : null);
      };
    }
    return v;
  }

  // Pop argc arguments from the stack, bind params (extra ignored), collect a
  // rest param into an array, and return the full args list (for LOAD_ARGS).
  function bindFrameArgs(fn, locals, argc) {
    const args = new Array(argc);
    for (let k = argc - 1; k >= 0; k--) args[k] = stack.pop();
    for (let k = 0; k < fn.nparams; k++) locals[k].v = (k < args.length ? args[k] : null);
    if (fn.restParam != null && fn.restParam >= 0) locals[fn.restParam].v = args.slice(fn.restParam);
    return args;
  }

  function makeFrame(fnIdx, argc, upvals) {
    const callee = fns[fnIdx];
    const locals = mkCells(callee.nlocals);
    const args = bindFrameArgs(callee, locals, argc);
    frames.push(frame);
    return { idx: fnIdx, fn: callee, i: 0, locals, upvals: upvals || [], args };
  }

  // Lightweight synchronous frame runner (used for non-async calls inside async runner)
  function runFrameSync(fnIdx, argc, upvals, thisObj) {
    const localFn = fns[fnIdx];
    const locals = mkCells(localFn.nlocals);
    const __args = bindFrameArgs(localFn, locals, argc);
    const localFrame = { idx: fnIdx, fn: localFn, i: 0, locals, upvals: upvals || [], thisObj: thisObj || null, args: __args };
    if (localFn.generator) localFrame.yields = []; // collect yields; returned at RET
    const localStack = [];
    const localMaps = maps[fnIdx];
    const localHandlers = [];
    const localRaise = (value) => {
      if (localHandlers.length) { const h = localHandlers.pop(); localFrame.i = localMaps[h.addr]; localStack.length = h.stackLen; localStack.push(value); return true; }
      return false;
    };
    while (true) {
      const ins = localFrame.fn.instrs[localFrame.i];
      if (!ins) throw new Error('runFrameSync: ran off the end of function ' + localFrame.fn.name);
      const op = ins.op, a = ins.args;
      localFrame.i++;
      try {
      switch (op) {
        case OP.PUSH_CONST: localStack.push(consts[a[0]]); break;
        case OP.PUSH_TRUE: localStack.push(true); break;
        case OP.PUSH_FALSE: localStack.push(false); break;
        case OP.PUSH_NULL: localStack.push(null); break;
        case OP.POP: localStack.pop(); break;
        case OP.DUP: localStack.push(localStack[localStack.length - 1]); break;
        case OP.LOAD: localStack.push(localFrame.locals[a[0]].v); break;
        case OP.STORE: localFrame.locals[a[0]].v = localStack.pop(); break;
        case OP.LOAD_UP: localStack.push(localFrame.upvals[a[0]].v); break;
        case OP.STORE_UP: localFrame.upvals[a[0]].v = localStack.pop(); break;
        case OP.ADD: { const y = localStack.pop(), x = localStack.pop(); localStack.push((typeof x === 'number' && typeof y === 'number') ? x + y : toStr(x) + toStr(y)); break; }
        case OP.SUB: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x - y); break; }
        case OP.MUL: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x * y); break; }
        case OP.DIV: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x / y); break; }
        case OP.MOD: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x % y); break; }
        case OP.NEG: localStack.push(-localStack.pop()); break;
        case OP.NOT: localStack.push(!truthy(localStack.pop())); break;
        case OP.EQ: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x === y); break; }
        case OP.NEQ: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x !== y); break; }
        case OP.LT: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x < y); break; }
        case OP.GT: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x > y); break; }
        case OP.LTE: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x <= y); break; }
        case OP.GTE: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x >= y); break; }
        case OP.BAND: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x & y)); break; }
        case OP.BOR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x | y)); break; }
        case OP.BXOR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x ^ y)); break; }
        case OP.SHL: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x << y)); break; }
        case OP.SHR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x >>> y)); break; }
        case OP.JMP: localFrame.i = localMaps[a[0]]; break;
        case OP.JZ: { const t = localStack.pop(); if (!truthy(t)) localFrame.i = localMaps[a[0]]; break; }
        case OP.JNZ: { const t = localStack.pop(); if (truthy(t)) localFrame.i = localMaps[a[0]]; break; }
        case OP.CALL: {
          const fnIdx = a[0], argc = a[1];
          const targetFn = fns[fnIdx];
          // prepare args
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          // if target is async, return a VM promise immediately (like JS)
          if (targetFn.async) {
            localStack.push(spawnAsync(fnIdx, argc, [], null));
          } else {
            // call synchronously via runFrameSync
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            const rv = runFrameSync(fnIdx, argc, [], null);
            localStack.push(rv);
          }
          // run microtasks after nested sync call completes (end of VM job slice)
          try { drainMicro(); } catch (e) { /* swallow; raise will handle if needed */ }
          break;
        }
        case OP.CALL_VALUE: {
          const argc = a[0];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          const callee = localStack.pop();
          if (typeof callee === 'function' && !isClosure(callee)) { localStack.push(callee.apply(null, args.map(toNative))); break; }
          if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
          const target = fns[callee.fn];
          if (target.async) {
            localStack.push(spawnAsync(callee.fn, argc, callee.upvals, null));
          } else {
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            const rv = runFrameSync(callee.fn, argc, callee.upvals, null);
            localStack.push(rv);
          }
          try { drainMicro(); } catch (e) { }
          break;
        }
        case OP.LOAD_THIS: {
          localStack.push(localFrame.thisObj !== undefined ? localFrame.thisObj : null);
          break;
        }
        case OP.LOAD_ARGS: { localStack.push(localFrame.args || []); break; }
        case OP.YIELD: { const yv = localStack.pop(); if (localFrame.yields) localFrame.yields.push(yv); localStack.push(null); break; }
        case OP.CALL_METHOD: {
          const argc = a[0];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          const callee = localStack.pop();
          const receiver = localStack.pop();
          if (typeof callee === 'function' && !isClosure(callee)) { localStack.push(callee.apply(receiver, args.map(toNative))); break; }
          if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
          const target = fns[callee.fn];
          if (target.async) {
            localStack.push(spawnAsync(callee.fn, argc, callee.upvals, receiver));
          } else {
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            const rv = runFrameSync(callee.fn, argc, callee.upvals, receiver);
            localStack.push(rv);
          }
          try { drainMicro(); } catch (e) { }
          break;
        }
        case OP.NEW: {
          const fnIdx = a[0], argc = a[1];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          // allocate instance with constructor's prototype if present
          const proto = fns[fnIdx] && fns[fnIdx].prototype ? fns[fnIdx].prototype : null;
          const instance = alloc(new VMObj(proto));
          if (fns[fnIdx].async) {
            // async constructor -> produce promise-wrapped instance
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            const jsP = runFrameAsync(fnIdx, argc, [], instance);
            const vmPromise = alloc(new VMObj()); vmPromise.__promise = true; vmPromise.jsPromise = jsP; pendingAsync.push(jsP);
            jsP.then((res) => { scheduleMicro(() => { vmPromise.resolved = instance; }); }).catch((err) => { scheduleMicro(() => { vmPromise.rejected = err; }); });
            localStack.push(vmPromise);
          } else {
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            runFrameSync(fnIdx, argc, [], instance);
            localStack.push(instance);
          }
          break;
        }
        case OP.NEW_VALUE: {
          const argc = a[0];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          const callee = localStack.pop();
          if (!isClosure(callee)) throw new Error('value is not a constructor: ' + toStr(callee));
          const proto = fns[callee.fn] && fns[callee.fn].prototype ? fns[callee.fn].prototype : null;
          const instance = alloc(new VMObj(proto));
          const target = fns[callee.fn];
          if (target.async) {
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            const jsP = runFrameAsync(callee.fn, argc, callee.upvals, instance);
            const vmPromise = alloc(new VMObj()); vmPromise.__promise = true; vmPromise.jsPromise = jsP; pendingAsync.push(jsP);
            jsP.then((res) => { scheduleMicro(() => { vmPromise.resolved = instance; }); }).catch((err) => { scheduleMicro(() => { vmPromise.rejected = err; }); });
            localStack.push(vmPromise);
          } else {
            for (let k = 0; k < argc; k++) localStack.push(args[k]);
            runFrameSync(callee.fn, argc, callee.upvals, instance);
            localStack.push(instance);
          }
          break;
        }
        case OP.RET: {
          const rv = localStack.pop();
          try { drainMicro(); } catch (e) { }
          return localFrame.yields || rv; // generators return their collected yields
        }
        case OP.CALL_HOST: {
          const nameIdx = a[0], argc = a[1];
          const args = new Array(argc);
          for (let j = argc - 1; j >= 0; j--) args[j] = localStack.pop();
          localStack.push(host(consts[nameIdx], args));
          break;
        }
        case OP.NEW_ARR: {
          const n = a[0], arr = new Array(n);
          for (let m = n - 1; m >= 0; m--) arr[m] = localStack.pop();
          localStack.push(arr);
          break;
        }
        case OP.NEW_OBJ: {
          const n = a[0], pairs = [];
          for (let m = 0; m < n; m++) { const v = localStack.pop(); const k = localStack.pop(); pairs.push([k, v]); }
          pairs.reverse();
          const obj = alloc(new VMObj());
          for (const [k, v] of pairs) obj.set(k, v);
          localStack.push(obj);
          break;
        }
        case OP.ARR_GET: { const key = localStack.pop(), obj = localStack.pop(); localStack.push(index(obj, key)); break; }
        case OP.ARR_SET: { const val = localStack.pop(), key = localStack.pop(), obj = localStack.pop(); indexSet(obj, key, val); localStack.push(val); break; }
        case OP.TRY: localHandlers.push({ addr: a[0], stackLen: localStack.length }); break;
        case OP.END_TRY: localHandlers.pop(); break;
        case OP.THROW: { throw { __vmthrow: true, v: localStack.pop() }; }
        case OP.PRINT: output.push(toStr(localStack.pop())); break;
        case OP.CLOSURE: {
          const cfn = fns[a[0]];
          const cells = cfn.upvals.map((d) => d.fromLocal ? localFrame.locals[d.index] : localFrame.upvals && localFrame.upvals[d.index]);
          if (program.upvalueMode === 'env') {
            const env = alloc(new VMObj());
            for (let i = 0; i < cfn.upvals.length; i++) env.set(cfn.upvals[i].name, cells[i]);
            localStack.push({ __closure: true, fn: a[0], upvals: { cells, env } });
          } else {
            localStack.push({ __closure: true, fn: a[0], upvals: cells });
          }
          break;
        }
        case OP.LOAD_UPVALUE: {
          const name = consts[a[0]];
          if (localFrame.upvals && localFrame.upvals.env) { const cell = localFrame.upvals.env.get(name); localStack.push(cell ? cell.v : null); break; }
          let found = -1; for (let i = 0; i < localFrame.fn.upvals.length; i++) if (localFrame.fn.upvals[i].name === name) { found = i; break; }
          if (found >= 0) { if (Array.isArray(localFrame.upvals)) localStack.push(localFrame.upvals[found].v); else if (localFrame.upvals && localFrame.upvals.cells) localStack.push(localFrame.upvals.cells[found].v); else localStack.push(null); } else localStack.push(null);
          break;
        }
        case OP.STORE_UPVALUE: {
          const name = consts[a[0]]; const val = localStack.pop(); if (localFrame.upvals && localFrame.upvals.env) { const cell = localFrame.upvals.env.get(name); if (cell) cell.v = val; break; } let found = -1; for (let i = 0; i < localFrame.fn.upvals.length; i++) if (localFrame.fn.upvals[i].name === name) { found = i; break; } if (found >= 0) { if (Array.isArray(localFrame.upvals)) localFrame.upvals[found].v = val; else if (localFrame.upvals && localFrame.upvals.cells) localFrame.upvals.cells[found].v = val; } break;
        }
        case OP.CLOSE_UPVALUE: {
          const slot = a[0];
          const cellOrVal = localFrame.locals[slot];
          if (!cellOrVal) break;
          if (typeof cellOrVal === 'object' && cellOrVal !== null && 'v' in cellOrVal) break;
          const val = cellOrVal;
          const newCell = alloc({ v: val });
          localFrame.locals[slot] = newCell;
          break;
        }
        // superinstructions
        case OP.LOADADD: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
        case OP.LOADSUB: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push(x - b); break; }
        case OP.LOADLT: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push(x < b); break; }
        case OP.CONSTADD: { const b = consts[a[0]], x = localStack.pop(); localStack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
      default: throw new Error('runFrameSync: illegal opcode ' + op);
      }
      } catch (e) {
        // VM-level exception: unwind to the nearest local handler; a real host
        // error is made catchable too. Rethrow to the caller frame if unhandled.
        if (e instanceof Error && !e.__vmthrow && /illegal opcode|ran off the end/.test(e.message)) throw e;
        const val = (e && e.__vmthrow) ? e.v : e;
        if (localRaise(val)) continue;
        throw e;
      }
      // maintain microtask ordering for sync runner as well
      drainMicro();
    }
  }

  // Async frame runner: supports awaiting and nested async functions
  async function runFrameAsync(fnIdx, argc, upvals, thisObj) {
    const localFn = fns[fnIdx];
    const locals = mkCells(localFn.nlocals);
    const __args = bindFrameArgs(localFn, locals, argc);
    const localFrame = { idx: fnIdx, fn: localFn, i: 0, locals, upvals: upvals || [], thisObj: thisObj || null, args: __args };
    if (localFn.generator) localFrame.yields = []; // collect yields; returned at RET
    const localStack = [];
    const localMaps = maps[fnIdx];
    const localHandlers = [];
    const localRaise = (value) => {
      if (localHandlers.length) { const h = localHandlers.pop(); localFrame.i = localMaps[h.addr]; localStack.length = h.stackLen; localStack.push(value); return true; }
      return false;
    };
    while (true) {
      const ins = localFrame.fn.instrs[localFrame.i];
      if (!ins) throw new Error('runFrameAsync: ran off the end of function ' + localFrame.fn.name);
      const op = ins.op, a = ins.args;
      localFrame.i++;
      try {
      switch (op) {
        case OP.PUSH_CONST: localStack.push(consts[a[0]]); break;
        case OP.PUSH_TRUE: localStack.push(true); break;
        case OP.PUSH_FALSE: localStack.push(false); break;
        case OP.PUSH_NULL: localStack.push(null); break;
        case OP.POP: localStack.pop(); break;
        case OP.DUP: localStack.push(localStack[localStack.length - 1]); break;
        case OP.LOAD: localStack.push(localFrame.locals[a[0]].v); break;
        case OP.STORE: localFrame.locals[a[0]].v = localStack.pop(); break;
        case OP.LOAD_UP: localStack.push(localFrame.upvals[a[0]].v); break;
        case OP.STORE_UP: localFrame.upvals[a[0]].v = localStack.pop(); break;
        case OP.ADD: { const y = localStack.pop(), x = localStack.pop(); localStack.push((typeof x === 'number' && typeof y === 'number') ? x + y : toStr(x) + toStr(y)); break; }
        case OP.SUB: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x - y); break; }
        case OP.MUL: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x * y); break; }
        case OP.DIV: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x / y); break; }
        case OP.MOD: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x % y); break; }
        case OP.NEG: localStack.push(-localStack.pop()); break;
        case OP.NOT: localStack.push(!truthy(localStack.pop())); break;
        case OP.EQ: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x === y); break; }
        case OP.NEQ: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x !== y); break; }
        case OP.LT: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x < y); break; }
        case OP.GT: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x > y); break; }
        case OP.LTE: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x <= y); break; }
        case OP.GTE: { const y = localStack.pop(), x = localStack.pop(); localStack.push(x >= y); break; }
        case OP.BAND: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x & y)); break; }
        case OP.BOR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x | y)); break; }
        case OP.BXOR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x ^ y)); break; }
        case OP.SHL: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x << y)); break; }
        case OP.SHR: { const y = localStack.pop(), x = localStack.pop(); localStack.push(u32(x >>> y)); break; }
        case OP.JMP: localFrame.i = localMaps[a[0]]; break;
        case OP.JZ: { const t = localStack.pop(); if (!truthy(t)) localFrame.i = localMaps[a[0]]; break; }
        case OP.JNZ: { const t = localStack.pop(); if (truthy(t)) localFrame.i = localMaps[a[0]]; break; }
        case OP.CALL: {
          const fnIdx = a[0], argc = a[1];
          const targetFn = fns[fnIdx];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          for (let k = 0; k < argc; k++) localStack.push(args[k]);
          if (targetFn.async) {
            // run async nested function
            const p = runFrameAsync(fnIdx, argc, [], null);
            const rv = await p;
            try { drainMicro(); } catch (e) { }
            localStack.push(rv);
          } else {
            const rv = runFrameSync(fnIdx, argc, [], null);
            localStack.push(rv);
          }
          break;
        }
        case OP.CALL_VALUE: {
          const argc = a[0];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          const callee = localStack.pop();
          if (typeof callee === 'function' && !isClosure(callee)) { localStack.push(callee.apply(null, args.map(toNative))); break; }
          if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
          for (let k = 0; k < argc; k++) localStack.push(args[k]);
          const target = fns[callee.fn];
          if (target.async) {
            const rv = await runFrameAsync(callee.fn, argc, callee.upvals, null);
            try { drainMicro(); } catch (e) { }
            localStack.push(rv);
          } else {
            const rv = runFrameSync(callee.fn, argc, callee.upvals, null);
            localStack.push(rv);
          }
          break;
        }
        case OP.CALL_METHOD: {
          const argc = a[0];
          const args = new Array(argc);
          for (let k = argc - 1; k >= 0; k--) args[k] = localStack.pop();
          const callee = localStack.pop();
          const receiver = localStack.pop();
          if (typeof callee === 'function' && !isClosure(callee)) { localStack.push(callee.apply(receiver, args.map(toNative))); break; }
          if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
          for (let k = 0; k < argc; k++) localStack.push(args[k]);
          const target = fns[callee.fn];
          if (target.async) {
            const rv = await runFrameAsync(callee.fn, argc, callee.upvals, receiver);
            try { drainMicro(); } catch (e) { }
            localStack.push(rv);
          } else {
            const rv = runFrameSync(callee.fn, argc, callee.upvals, receiver);
            localStack.push(rv);
          }
          break;
        }
        case OP.LOAD_THIS: { localStack.push(localFrame.thisObj !== undefined ? localFrame.thisObj : null); break; }
        case OP.LOAD_ARGS: { localStack.push(localFrame.args || []); break; }
        case OP.YIELD: { const yv = localStack.pop(); if (localFrame.yields) localFrame.yields.push(yv); localStack.push(null); break; }
        case OP.RET: {
          const rv = localStack.pop();
          return localFrame.yields || rv; // generators return their collected yields
        }
        case OP.CALL_HOST: {
          const nameIdx = a[0], argc = a[1];
          const args = new Array(argc);
          for (let j = argc - 1; j >= 0; j--) args[j] = localStack.pop();
          localStack.push(host(consts[nameIdx], args));
          break;
        }
        case OP.NEW_ARR: {
          const n = a[0], arr = new Array(n);
          for (let m = n - 1; m >= 0; m--) arr[m] = localStack.pop();
          localStack.push(arr);
          break;
        }
        case OP.NEW_OBJ: {
          const n = a[0], pairs = [];
          for (let m = 0; m < n; m++) { const v = localStack.pop(); const k = localStack.pop(); pairs.push([k, v]); }
          pairs.reverse();
          const obj = alloc(new VMObj());
          for (const [k, v] of pairs) obj.set(k, v);
          localStack.push(obj);
          break;
        }
        case OP.ARR_GET: { const key = localStack.pop(), obj = localStack.pop(); localStack.push(index(obj, key)); break; }
        case OP.ARR_SET: { const val = localStack.pop(), key = localStack.pop(), obj = localStack.pop(); indexSet(obj, key, val); localStack.push(val); break; }
        case OP.TRY: localHandlers.push({ addr: a[0], stackLen: localStack.length }); break;
        case OP.END_TRY: localHandlers.pop(); break;
        case OP.THROW: { throw { __vmthrow: true, v: localStack.pop() }; }
        case OP.PRINT: output.push(toStr(localStack.pop())); break;
        case OP.CLOSURE: {
          const cfn = fns[a[0]];
          const cells = cfn.upvals.map((d) => d.fromLocal ? localFrame.locals[d.index] : localFrame.upvals && localFrame.upvals[d.index]);
          if (program.upvalueMode === 'env') {
            const env = alloc(new VMObj());
            for (let i = 0; i < cfn.upvals.length; i++) env.set(cfn.upvals[i].name, cells[i]);
            localStack.push({ __closure: true, fn: a[0], upvals: { cells, env } });
          } else {
            localStack.push({ __closure: true, fn: a[0], upvals: cells });
          }
          break;
        }
        case OP.LOAD_UPVALUE: {
          const name = consts[a[0]];
          if (localFrame.upvals && localFrame.upvals.env) { const cell = localFrame.upvals.env.get(name); localStack.push(cell ? cell.v : null); break; }
          let found = -1; for (let i = 0; i < localFrame.fn.upvals.length; i++) if (localFrame.fn.upvals[i].name === name) { found = i; break; }
          if (found >= 0) { if (Array.isArray(localFrame.upvals)) localStack.push(localFrame.upvals[found].v); else if (localFrame.upvals && localFrame.upvals.cells) localStack.push(localFrame.upvals.cells[found].v); else localStack.push(null); } else localStack.push(null);
          break;
        }
        case OP.STORE_UPVALUE: {
          const name = consts[a[0]]; const val = localStack.pop(); if (localFrame.upvals && localFrame.upvals.env) { const cell = localFrame.upvals.env.get(name); if (cell) cell.v = val; break; } let found = -1; for (let i = 0; i < localFrame.fn.upvals.length; i++) if (localFrame.fn.upvals[i].name === name) { found = i; break; } if (found >= 0) { if (Array.isArray(localFrame.upvals)) localFrame.upvals[found].v = val; else if (localFrame.upvals && localFrame.upvals.cells) localFrame.upvals.cells[found].v = val; } break;
        }
        case OP.CLOSE_UPVALUE: {
          const slot = a[0];
          const cellOrVal = localFrame.locals[slot];
          if (!cellOrVal) break;
          if (typeof cellOrVal === 'object' && cellOrVal !== null && 'v' in cellOrVal) break;
          const val = cellOrVal;
          const newCell = alloc({ v: val });
          localFrame.locals[slot] = newCell;
          break;
        }
        case OP.AWAIT: {
          const p = localStack.pop();
          if (p && (typeof p === 'object' || typeof p === 'function') && typeof p.then === 'function' && !isObj(p) && !p.__promise) {
            try { const rv = await p; try { drainMicro(); } catch (e) {} localStack.push(rv); }
            catch (err) { if (!raise(err)) throw err; }
            break;
          }
          if (p && typeof p === 'object' && p.__promise && p.jsPromise) {
            try {
              const rv = await p.jsPromise;
              try { drainMicro(); } catch (e) { }
              localStack.push(rv);
            } catch (err) {
              if (!raise(err)) throw err;
            }
          } else {
            localStack.push(p);
          }
          break;
        }
        // superinstructions
        case OP.LOADADD: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
        case OP.LOADSUB: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push(x - b); break; }
        case OP.LOADLT: { const b = localFrame.locals[a[0]].v, x = localStack.pop(); localStack.push(x < b); break; }
        case OP.CONSTADD: { const b = consts[a[0]], x = localStack.pop(); localStack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
      default: throw new Error('runFrameAsync: illegal opcode ' + op);
      }
      } catch (e) {
        if (e instanceof Error && !e.__vmthrow && /illegal opcode|ran off the end/.test(e.message)) throw e;
        const val = (e && e.__vmthrow) ? e.v : e;
        if (localRaise(val)) continue;
        throw e;
      }
    }
  }

  // Unwind to the nearest handler; returns false if the exception is uncaught.
  function raise(value) {
    // find the nearest handler that accepts this exception (respect type filters)
    for (let idx = handlers.length - 1; idx >= 0; idx--) {
      const h = handlers[idx];
      if (h.meta && h.meta.catchType) {
        const t = h.meta.catchType;
        if (typeof t === 'string') {
          const g = globalThis[t];
          if (g && typeof g === 'function') {
            if (!(value instanceof g)) continue;
          } else {
            if (typeof value !== t) continue;
          }
        }
      }
      // pop any handlers above the chosen one
      while (handlers.length - 1 > idx) handlers.pop();
      const chosen = handlers[handlers.length - 1];
      frames.length = chosen.framesLen;
      frame = chosen.frame;
      stack.length = chosen.stackLen;
      frame.i = maps[chosen.fnIdx][chosen.addr];
      stack.push(value);
      return true;
    }
    return false;
  }

  // If the entry function is async, run it in the async frame runner so AWAIT works
  if (frame.fn && frame.fn.async) {
    const rv = await runFrameAsync(frame.idx, 0, frame.upvals, frame.thisObj || null);
    try { drainMicro(); } catch (e) { }
    return { output, steps, returnValue: rv, trace };
  }

  for (;;) {
    if (maxSteps && steps >= maxSteps) throw new Error('interp: step limit exceeded');
    const ins = frame.fn.instrs[frame.i];
    if (!ins) throw new Error('interp: ran off the end of function ' + frame.fn.name);
    const op = ins.op;
    const a = ins.args;
    if (trace) {
      trace.push({
        step: steps, fn: frame.fn.name, i: frame.i, op: OP_NAME[op],
        args: a.slice(), stack: stack.map(toStr), locals: frame.locals.map((c) => toStr(c.v)),
      });
    }
    frame.i++;
    steps++;

    try {
    switch (op) {
      case OP.HALT: {
        try { drainMicro(); } catch (e) { }
        await settleAll(); // finish pending async work before returning
        return { output, steps, returnValue: undefined, trace };
      }
      case OP.PUSH_CONST: stack.push(consts[a[0]]); break;
      case OP.PUSH_TRUE: stack.push(true); break;
      case OP.PUSH_FALSE: stack.push(false); break;
      case OP.PUSH_NULL: stack.push(null); break;
      case OP.POP: stack.pop(); break;
      case OP.DUP: stack.push(stack[stack.length - 1]); break;
      case OP.LOAD: stack.push(frame.locals[a[0]].v); break;
      case OP.STORE: frame.locals[a[0]].v = stack.pop(); break;
      case OP.LOAD_UP: {
        const idx = a[0];
        if (!frame.upvals) { stack.push(null); break; }
        if (Array.isArray(frame.upvals)) { stack.push(frame.upvals[idx].v); break; }
        if (frame.upvals && frame.upvals.cells) { stack.push(frame.upvals.cells[idx].v); break; }
        // fallback: try to resolve by name via function descriptor
        if (frame.upvals && frame.upvals.env) {
          const name = frame.fn.upvals[idx] && frame.fn.upvals[idx].name;
          const cell = name ? frame.upvals.env.get(name) : null;
          stack.push(cell ? cell.v : null);
          break;
        }
        stack.push(null);
        break;
      }
      case OP.STORE_UP: {
        const idx = a[0];
        const val = stack.pop();
        if (!frame.upvals) break;
        if (Array.isArray(frame.upvals)) { frame.upvals[idx].v = val; break; }
        if (frame.upvals && frame.upvals.cells) { frame.upvals.cells[idx].v = val; break; }
        if (frame.upvals && frame.upvals.env) {
          const name = frame.fn.upvals[idx] && frame.fn.upvals[idx].name;
          const cell = name ? frame.upvals.env.get(name) : null;
          if (cell) cell.v = val;
          break;
        }
        break;
      }
      case OP.ADD: { const y = stack.pop(), x = stack.pop(); stack.push((typeof x === 'number' && typeof y === 'number') ? x + y : toStr(x) + toStr(y)); break; }
      case OP.SUB: { const y = stack.pop(), x = stack.pop(); stack.push(x - y); break; }
      case OP.MUL: { const y = stack.pop(), x = stack.pop(); stack.push(x * y); break; }
      case OP.DIV: { const y = stack.pop(), x = stack.pop(); stack.push(x / y); break; }
      case OP.MOD: { const y = stack.pop(), x = stack.pop(); stack.push(x % y); break; }
      case OP.NEG: stack.push(-stack.pop()); break;
      case OP.NOT: stack.push(!truthy(stack.pop())); break;
      case OP.EQ: { const y = stack.pop(), x = stack.pop(); stack.push(x === y); break; }
      case OP.NEQ: { const y = stack.pop(), x = stack.pop(); stack.push(x !== y); break; }
      case OP.LT: { const y = stack.pop(), x = stack.pop(); stack.push(x < y); break; }
      case OP.GT: { const y = stack.pop(), x = stack.pop(); stack.push(x > y); break; }
      case OP.LTE: { const y = stack.pop(), x = stack.pop(); stack.push(x <= y); break; }
      case OP.GTE: { const y = stack.pop(), x = stack.pop(); stack.push(x >= y); break; }
      case OP.BAND: { const y = stack.pop(), x = stack.pop(); stack.push(u32(x & y)); break; }
      case OP.BOR: { const y = stack.pop(), x = stack.pop(); stack.push(u32(x | y)); break; }
      case OP.BXOR: { const y = stack.pop(), x = stack.pop(); stack.push(u32(x ^ y)); break; }
      case OP.SHL: { const y = stack.pop(), x = stack.pop(); stack.push(u32(x << y)); break; }
      case OP.SHR: { const y = stack.pop(), x = stack.pop(); stack.push(u32(x >>> y)); break; }
      case OP.JMP: frame.i = maps[frame.idx][a[0]]; break;
      case OP.JZ: { const t = stack.pop(); if (!truthy(t)) frame.i = maps[frame.idx][a[0]]; break; }
      case OP.JNZ: { const t = stack.pop(); if (truthy(t)) frame.i = maps[frame.idx][a[0]]; break; }
      case OP.CALL: {
        const fnIdx = a[0], argc = a[1];
        const targetFn = fns[fnIdx];
        if (targetFn.async) {
          // args are already on the stack; runFrameAsync pops them.
          stack.push(spawnAsync(fnIdx, argc, [], null));
        } else if (targetFn.generator) {
          stack.push(runFrameSync(fnIdx, argc, [], null)); // returns collected yields
        } else {
          frame = makeFrame(fnIdx, argc, []);
        }
        break;
      }
      case OP.CALL_VALUE: {
        const argc = a[0];
        const args = new Array(argc);
        for (let k = argc - 1; k >= 0; k--) args[k] = stack.pop();
        const callee = stack.pop();
        // Native function value: call it directly (bridging VM-closure args).
        if (typeof callee === 'function' && !isClosure(callee)) {
          stack.push(callee.apply(null, args.map(toNative)));
          break;
        }
        // special host-backed closures (minimal Promise.then bridge)
        if (callee && callee.__host === 'promiseThen') {
          const onFul = args[0] || null;
          const prom = callee.__promiseRef;
          // if already settled, schedule the callback; otherwise hook into jsPromise if present
          const invoke = (val) => {
            scheduleMicro(() => {
              try {
                if (onFul && isClosure(onFul)) {
                  stack.push(val);
                  const tf = fns[onFul.fn];
                  if (tf && tf.async) runFrameAsync(onFul.fn, 1, onFul.upvals, null).catch((e) => { try { if (!raise(e)) throw e; } catch(_){} });
                  else runFrameSync(onFul.fn, 1, onFul.upvals, null);
                }
              } catch (e) { try { if (!raise(e)) throw e; } catch(_){} }
            });
          };
          if (prom) {
            if (prom.jsPromise) prom.jsPromise.then((v) => invoke(v)).catch((e) => { try { if (!raise(e)) throw e; } catch(_){} });
            else if (prom.resolved !== undefined) scheduleMicro(() => invoke(prom.resolved));
            else if (prom.rejected !== undefined) scheduleMicro(() => { try { if (!raise(prom.rejected)) throw prom.rejected; } catch(_){} });
          }
          // then returns null in this minimal bridge
          stack.push(null);
        } else {
        if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
        for (let k = 0; k < argc; k++) stack.push(args[k]);
        const target = fns[callee.fn];
        if (target.async) {
          stack.push(spawnAsync(callee.fn, argc, callee.upvals, null));
        } else if (target.generator) {
          stack.push(runFrameSync(callee.fn, argc, callee.upvals, null));
        } else {
          // args are already on the stack from the push above; makeFrame pops them.
          frame = makeFrame(callee.fn, argc, callee.upvals);
        }
        break;
      }
      }
      case OP.LOAD_THIS: {
        stack.push(frame.thisObj !== undefined ? frame.thisObj : null);
        break;
      }
      case OP.LOAD_ARGS: { stack.push(frame.args || []); break; }
      case OP.YIELD: { const yv = stack.pop(); if (frame.yields) frame.yields.push(yv); stack.push(null); break; }
      case OP.CALL_METHOD: {
        const argc = a[0];
        const args = new Array(argc);
        for (let k = argc - 1; k >= 0; k--) args[k] = stack.pop();
        const callee = stack.pop();
        const receiver = stack.pop();
        // Native method dispatch: call a real host method on a native receiver,
        // bridging any VM-closure arguments (e.g. arr.map(x => ...)) to callables.
        if (typeof callee === 'function' && !isClosure(callee)) {
          stack.push(callee.apply(receiver, args.map(toNative)));
          break;
        }
        if (!isClosure(callee)) throw new Error('value is not callable: ' + toStr(callee));
        const target = fns[callee.fn];
        if (target.async) {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          stack.push(spawnAsync(callee.fn, argc, callee.upvals, receiver));
        } else if (target.generator) {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          stack.push(runFrameSync(callee.fn, argc, callee.upvals, receiver));
        } else {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          frame = makeFrame(callee.fn, argc, callee.upvals);
          frame.thisObj = receiver;
        }
        break;
      }
      case OP.NEW: {
        const fnIdx = a[0], argc = a[1];
        const args = new Array(argc);
        for (let k = argc - 1; k >= 0; k--) args[k] = stack.pop();
        const proto = fns[fnIdx] && fns[fnIdx].prototype ? fns[fnIdx].prototype : null;
        const instance = alloc(new VMObj(proto));
        if (fns[fnIdx].async) {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          const jsP = runFrameAsync(fnIdx, argc, [], instance);
          const vmPromise = alloc(new VMObj()); vmPromise.__promise = true;
          vmPromise.jsPromise = jsP; pendingAsync.push(jsP);
          jsP.then((res) => { scheduleMicro(() => { vmPromise.resolved = instance; }); }).catch((err) => { scheduleMicro(() => { vmPromise.rejected = err; }); });
          vmPromise.set('then', { __closure: true, __host: 'promiseThen', __promiseRef: vmPromise });
          stack.push(vmPromise);
        } else {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          runFrameSync(fnIdx, argc, [], instance);
          stack.push(instance);
        }
        break;
      }
      case OP.NEW_VALUE: {
        const argc = a[0];
        const args = new Array(argc);
        for (let k = argc - 1; k >= 0; k--) args[k] = stack.pop();
        const callee = stack.pop();
        if (!isClosure(callee)) throw new Error('value is not a constructor: ' + toStr(callee));
        const proto = fns[callee.fn] && fns[callee.fn].prototype ? fns[callee.fn].prototype : null;
        const instance = alloc(new VMObj(proto));
        const target = fns[callee.fn];
        if (target.async) {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          const jsP = runFrameAsync(callee.fn, argc, callee.upvals, instance);
          const vmPromise = alloc(new VMObj()); vmPromise.__promise = true;
          vmPromise.jsPromise = jsP; pendingAsync.push(jsP);
          jsP.then((res) => { scheduleMicro(() => { vmPromise.resolved = instance; }); }).catch((err) => { scheduleMicro(() => { vmPromise.rejected = err; }); });
          vmPromise.set('then', { __closure: true, __host: 'promiseThen', __promiseRef: vmPromise });
          stack.push(vmPromise);
        } else {
          for (let k = 0; k < argc; k++) stack.push(args[k]);
          runFrameSync(callee.fn, argc, callee.upvals, instance);
          stack.push(instance);
        }
        break;
      }
      case OP.AWAIT: {
        const p = stack.pop();
        if (p && typeof p === 'object' && p.__promise && p.jsPromise) {
          try {
            const rv = await p.jsPromise;
            try { drainMicro(); } catch (e) { }
            stack.push(rv);
          } catch (err) {
            if (!raise(err)) throw err;
          }
        } else if (p && (typeof p === 'object' || typeof p === 'function') && typeof p.then === 'function' && !isObj(p)) {
          // real host thenable (e.g. Promise.resolve(...).then(...))
          try { const rv = await p; try { drainMicro(); } catch (e) {} stack.push(rv); }
          catch (err) { if (!raise(err)) throw err; }
        } else {
          stack.push(p);
        }
        break;
      }
      case OP.CLOSURE: {
        const cfn = fns[a[0]];
        // create captured cells and optionally an env object if the compiled
        // program requested explicit env objects (program.upvalueMode === 'env')
        const cells = cfn.upvals.map((d) => d.fromLocal ? frame.locals[d.index] : frame.upvals && frame.upvals[d.index]);
        if (program.upvalueMode === 'env') {
          const env = alloc(new VMObj());
          for (let i = 0; i < cfn.upvals.length; i++) env.set(cfn.upvals[i].name, cells[i]);
          stack.push({ __closure: true, fn: a[0], upvals: { cells, env } });
        } else {
          stack.push({ __closure: true, fn: a[0], upvals: cells });
        }
        break;
      }
      case OP.RET: {
        const rv = stack.pop();
        if (frames.length === 0) {
          try { drainMicro(); } catch (e) { }
          return { output, steps, returnValue: rv, trace };
        }
        frame = frames.pop();
        stack.push(rv);
        break;
      }
      case OP.CALL_HOST: {
        const nameIdx = a[0], argc = a[1];
        const args = new Array(argc);
        for (let j = argc - 1; j >= 0; j--) args[j] = stack.pop();
        stack.push(host(consts[nameIdx], args));
        break;
      }
      case OP.NEW_ARR: {
        const n = a[0], arr = new Array(n);
        for (let m = n - 1; m >= 0; m--) arr[m] = stack.pop();
        stack.push(arr);
        break;
      }
      case OP.NEW_OBJ: {
        const n = a[0], pairs = [];
        for (let m = 0; m < n; m++) { const v = stack.pop(); const k = stack.pop(); pairs.push([k, v]); }
        pairs.reverse();
        const obj = alloc(new VMObj());
        for (const [k, v] of pairs) obj.set(k, v);
        stack.push(obj);
        break;
      }
      case OP.ARR_GET: { const key = stack.pop(), obj = stack.pop(); stack.push(index(obj, key)); break; }
      case OP.ARR_SET: { const val = stack.pop(), key = stack.pop(), obj = stack.pop(); indexSet(obj, key, val); stack.push(val); break; }
      case OP.TRY: {
        // locate handler metadata for this function by the handler address
        const meta = (frame.fn.handlers || []).find((h) => h.addr === a[0]) || null;
        handlers.push({ fnIdx: frame.idx, frame, framesLen: frames.length, stackLen: stack.length, addr: a[0], meta });
        break;
      }
      case OP.END_TRY: handlers.pop(); break;
      case OP.THROW: {
        const value = stack.pop();
        if (!raise(value)) throw new Error('uncaught exception: ' + toStr(value));
        break;
      }
      case OP.LOAD_UPVALUE: {
        const name = consts[a[0]];
        // try current frame's upvals map, or fall back to scanning the function's upval descriptors
        if (frame.upvals && frame.upvals.env) {
          const cell = frame.upvals.env.get(name);
          stack.push(cell ? cell.v : null);
          break;
        }
        // fallback: find index in fn.upvals
        let found = -1;
        for (let i = 0; i < frame.fn.upvals.length; i++) if (frame.fn.upvals[i].name === name) { found = i; break; }
        if (found >= 0) {
          if (Array.isArray(frame.upvals)) stack.push(frame.upvals[found].v);
          else if (frame.upvals && frame.upvals.cells) stack.push(frame.upvals.cells[found].v);
          else stack.push(null);
        } else stack.push(null);
        break;
      }
      case OP.STORE_UPVALUE: {
        const name = consts[a[0]];
        const val = stack.pop();
        if (frame.upvals && frame.upvals.env) {
          const cell = frame.upvals.env.get(name);
          if (cell) cell.v = val;
          break;
        }
        let found = -1;
        for (let i = 0; i < frame.fn.upvals.length; i++) if (frame.fn.upvals[i].name === name) { found = i; break; }
        if (found >= 0) {
          if (Array.isArray(frame.upvals)) frame.upvals[found].v = val;
          else if (frame.upvals && frame.upvals.cells) frame.upvals.cells[found].v = val;
        }
        break;
      }
      case OP.CLOSE_UPVALUE: {
        const slot = a[0];
        // ensure the local slot is a heap cell object ({v: ...}) so closures can outlive the frame
        const cellOrVal = frame.locals[slot];
        if (!cellOrVal) break;
        // if it's already a cell object with 'v' property, nothing to do
        if (typeof cellOrVal === 'object' && cellOrVal !== null && 'v' in cellOrVal) break;
        // otherwise wrap primitive into cell
        const val = cellOrVal;
        const newCell = alloc({ v: val });
        frame.locals[slot] = newCell;
        // also update any upvals descriptors that pointed to this local slot (fromLocal)
        for (let fi = 0; fi < fns.length; fi++) {
          const fdesc = fns[fi];
          if (!fdesc.upvals) continue;
          for (let ui = 0; ui < fdesc.upvals.length; ui++) {
            const ud = fdesc.upvals[ui];
            if (ud.fromLocal && ud.index === slot && frames.length && frames[frames.length - 1] && frames[frames.length - 1].locals === frame.locals) {
              // replace any closure-held reference? This heuristic may be imperfect.
              // Scan current stack for closures capturing this cell and update
              for (let s = 0; s < stack.length; s++) {
                const v = stack[s];
                if (isClosure(v) && v.upvals && v.upvals.cells && v.upvals.cells[ui] && !('v' in v.upvals.cells[ui])) {
                  v.upvals.cells[ui] = newCell;
                }
              }
            }
          }
        }
        break;
      }
      case OP.PRINT: output.push(toStr(stack.pop())); break;
      // superinstructions
      case OP.LOADADD: { const b = frame.locals[a[0]].v, x = stack.pop(); stack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
      case OP.LOADSUB: { const b = frame.locals[a[0]].v, x = stack.pop(); stack.push(x - b); break; }
      case OP.LOADLT: { const b = frame.locals[a[0]].v, x = stack.pop(); stack.push(x < b); break; }
      case OP.CONSTADD: { const b = consts[a[0]], x = stack.pop(); stack.push((typeof x === 'number' && typeof b === 'number') ? x + b : toStr(x) + toStr(b)); break; }
      default: throw new Error('interp: illegal opcode ' + op);
    }
    } catch (e) {
      // Route VM throws (and host errors surfacing from native calls) through the
      // handler stack so try/catch across native boundaries works.
      if (e instanceof Error && !e.__vmthrow && /illegal opcode|ran off the end/.test(e.message)) throw e;
      const val = (e && e.__vmthrow) ? e.v : e;
      if (!raise(val)) throw (e && e.__vmthrow) ? new Error('uncaught exception: ' + toStr(val)) : e;
    }
    // drain microtasks after each top-level instruction so Promise reactions run ASAP
    drainMicro();
  }
}

module.exports = { interpret, VMObj };
