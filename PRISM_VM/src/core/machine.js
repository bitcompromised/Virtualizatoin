'use strict';
// The shared machine: builds the VM facade `F` over concrete state and runs the
// spec dispatch loop. Written as ONE self-contained function so it powers both
// the in-process interpreter (called directly) and the standalone emitted VM
// (embedded verbatim via Function.prototype.toString) -- the same semantics,
// never re-implemented per backend.
//
// `image` = { consts: [...], functions: [{ code: number[], nlocals, nparams }] }
// `execById` = array indexed by opcode id -> exec(F)  (from the opcode spec)

function execProgram(image, execById, opts) {
  opts = opts || {};
  const out = [];
  const print = opts.print || function (s) { out.push(String(s)); };
  const fns = image.functions;
  const consts = image.consts;
  const stack = [];
  let frames = [];
  // Locals are shared CELLS ({ v }) so a closure that captures a variable sees
  // later mutations to it. Cells never reach the operand stack -- getLocal /
  // setLocal deref them, and a closure captures the cell object by reference.
  const mkLocals = function (n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = { v: null }; return a; };
  let frame = { code: fns[0].code, ip: 0, locals: mkLocals(fns[0].nlocals), upvals: [] };
  let running = true;

  const toStr = function (v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (Array.isArray(v)) { const p = []; for (let k = 0; k < v.length; k++) p.push(toStr(v[k])); return '[' + p.join(', ') + ']'; }
    if (typeof v === 'object' && v.__closure) return 'function';
    if (typeof v === 'object') { const ks = Object.keys(v); const p = []; for (let k = 0; k < ks.length; k++) p.push(ks[k] + ': ' + toStr(v[ks[k]])); return '{' + p.join(', ') + '}'; }
    return String(v);
  };

  const F = {
    // stack
    pop: function () { return stack.pop(); },
    push: function (v) { stack.push(v); },
    peek: function () { return stack[stack.length - 1]; },
    // operand fetch (advances the current frame's ip)
    u16: function () { const lo = frame.code[frame.ip++], hi = frame.code[frame.ip++]; return lo | (hi << 8); },
    u8: function () { return frame.code[frame.ip++]; },
    // storage
    getConst: function (i) { return consts[i]; },
    getLocal: function (i) { return frame.locals[i].v; },
    setLocal: function (i, v) { frame.locals[i].v = v; },
    getUpval: function (i) { return frame.upvals[i].v; },
    setUpval: function (i, v) { frame.upvals[i].v = v; },
    makeClosure: function (fnIdx) {
      var desc = fns[fnIdx].upvals || [];
      var ups = new Array(desc.length);
      for (var k = 0; k < desc.length; k++) ups[k] = desc[k].fromLocal ? frame.locals[desc[k].index] : frame.upvals[desc[k].index];
      return { __closure: true, fn: fnIdx, upvals: ups };
    },
    callValue: function (argc) {
      var av = new Array(argc);
      for (var k = argc - 1; k >= 0; k--) av[k] = stack.pop();
      var callee = stack.pop();
      if (!callee || !callee.__closure) throw new Error('value is not callable: ' + toStr(callee));
      var fn = fns[callee.fn];
      var locals = mkLocals(fn.nlocals);
      for (var j = 0; j < argc && j < fn.nparams; j++) locals[j].v = av[j];
      frames.push(frame);
      frame = { code: fn.code, ip: 0, locals: locals, upvals: callee.upvals };
    },
    setIp: function (a) { frame.ip = a; },
    // value operations (the whole numeric/string semantics live here)
    add: function (a, b) { return (typeof a === 'number' && typeof b === 'number') ? a + b : toStr(a) + toStr(b); },
    sub: function (a, b) { return a - b; },
    mul: function (a, b) { return a * b; },
    div: function (a, b) { return a / b; },
    mod: function (a, b) { return a % b; },
    neg: function (a) { return -a; },
    eq: function (a, b) { return a === b; },
    lt: function (a, b) { return a < b; },
    truthy: function (v) { return !(v === null || v === undefined || v === false || v === 0 || v === '' || (typeof v === 'number' && isNaN(v))); },
    toStr: toStr,
    print: function (v) { print(toStr(v)); },
    // array value primitives (the value model lives in the machine)
    newArray: function (count) { var arr = new Array(count); for (var k = count - 1; k >= 0; k--) arr[k] = stack.pop(); return arr; },
    newObject: function (count) { var pairs = []; for (var k = 0; k < count; k++) { var vv = stack.pop(); var kk = stack.pop(); pairs.push([kk, vv]); } pairs.reverse(); var o = {}; for (var p = 0; p < pairs.length; p++) o[pairs[p][0]] = pairs[p][1]; return o; },
    indexGet: function (a, i) { if (a === null || a === undefined) return null; var v = a[i]; return v === undefined ? null : v; },
    indexSet: function (a, i, v) { if (a !== null && a !== undefined) a[i] = v; },
    len: function (a) { return (a === null || a === undefined) ? 0 : (a.length || 0); },
    host: function (name, count) {
      var args = new Array(count); for (var k = count - 1; k >= 0; k--) args[k] = stack.pop();
      var a = args[0], b = args[1], i;
      if (name === 'floor') return Math.floor(a);
      if (name === 'ceil') return Math.ceil(a);
      if (name === 'round') return Math.round(a);
      if (name === 'abs') return Math.abs(a);
      if (name === 'sqrt') return Math.sqrt(a);
      if (name === 'pow') return Math.pow(a, b);
      if (name === 'min') { var m = args[0]; for (i = 1; i < args.length; i++) if (args[i] < m) m = args[i]; return m; }
      if (name === 'max') { var mx = args[0]; for (i = 1; i < args.length; i++) if (args[i] > mx) mx = args[i]; return mx; }
      if (name === 'num') return Number(a);
      if (name === 'str') return toStr(a);
      throw new Error('unknown host function: ' + name);
    },
    halt: function () { running = false; },
    // calls
    call: function (fnIdx, argc) {
      const fn = fns[fnIdx];
      const locals = mkLocals(fn.nlocals);
      const av = new Array(argc);
      for (let k = argc - 1; k >= 0; k--) av[k] = stack.pop();
      for (let j = 0; j < argc && j < fn.nparams; j++) locals[j].v = av[j];
      frames.push(frame);
      frame = { code: fn.code, ip: 0, locals: locals, upvals: [] };
    },
    ret: function () {
      const rv = stack.pop();
      if (frames.length === 0) { running = false; stack.push(rv); return; }
      frame = frames.pop();
      stack.push(rv);
    },
  };

  let steps = 0;
  const MAX = opts.maxSteps || 20000000;
  while (running) {
    if (++steps > MAX) throw new Error('resource limit: instruction budget exceeded');
    const op = frame.code[frame.ip++];
    const ex = execById[op];
    if (!ex) throw new Error('illegal opcode ' + op + ' at ip=' + (frame.ip - 1));
    ex(F);
  }
  return { output: out, steps: steps };
}

module.exports = { execProgram };
