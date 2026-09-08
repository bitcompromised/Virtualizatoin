'use strict';
// A second MACHINE MODEL: a register-file machine. The operand stack lives in an
// explicit register array `R` addressed by a stack pointer `sp`, instead of a JS
// Array with push/pop. The SAME sem-generated opcode handlers run on it unchanged
// -- they only ever touch the facade `F` -- which is the point: the opcode spec
// is decoupled from the machine model, so "one spec, many machines" holds across
// machine models too, not just languages.
//
// `encrypted: true` holds the live stack pointer MASKED (sp XOR key) -- a safe,
// always-correct obfuscation of VM state. (Prism values are numbers/strings/
// bool/null with no object type, so this stays simple and correct for all
// values; the value ops mirror machine.js and are kept honest by conformance.)

function execProgramReg(image, execById, opts) {
  opts = opts || {};
  var enc = opts.encrypted === true;
  var KEY = ((opts.seed !== undefined ? opts.seed : 0x2545f491) & 0x7fffffff) >>> 0;
  var out = [];
  var print = opts.print || function (s) { out.push(String(s)); };
  var fns = image.functions;
  var consts = image.consts;
  var R = [];            // the register file (operand stack storage)
  var spm = enc ? (0 ^ KEY) : 0; // stack pointer, masked when encrypted
  function getSp() { return enc ? (spm ^ KEY) : spm; }
  function setSp(v) { spm = enc ? (v ^ KEY) : v; }
  var frames = [];
  var mkLocals = function (n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = { v: null }; return a; };
  var frame = { code: fns[0].code, ip: 0, locals: mkLocals(fns[0].nlocals), upvals: [] };
  var running = true;

  var toStr = function (v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (Array.isArray(v)) { var p = []; for (var k = 0; k < v.length; k++) p.push(toStr(v[k])); return '[' + p.join(', ') + ']'; }
    if (typeof v === 'object' && v.__closure) return 'function';
    if (typeof v === 'object') { var ks = Object.keys(v); var q = []; for (var j = 0; j < ks.length; j++) q.push(ks[j] + ': ' + toStr(v[ks[j]])); return '{' + q.join(', ') + '}'; }
    return String(v);
  };

  var F = {
    pop: function () { var s = getSp() - 1; setSp(s); return R[s]; },
    push: function (v) { var s = getSp(); R[s] = v; setSp(s + 1); },
    peek: function () { return R[getSp() - 1]; },
    u16: function () { var lo = frame.code[frame.ip++], hi = frame.code[frame.ip++]; return lo | (hi << 8); },
    u8: function () { return frame.code[frame.ip++]; },
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
      for (var k = argc - 1; k >= 0; k--) av[k] = F.pop();
      var callee = F.pop();
      if (!callee || !callee.__closure) throw new Error('value is not callable: ' + toStr(callee));
      var fn = fns[callee.fn];
      var locals = mkLocals(fn.nlocals);
      for (var j = 0; j < argc && j < fn.nparams; j++) locals[j].v = av[j];
      frames.push(frame);
      frame = { code: fn.code, ip: 0, locals: locals, upvals: callee.upvals };
    },
    setIp: function (a) { frame.ip = a; },
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
    newArray: function (count) { var arr = new Array(count); for (var k = count - 1; k >= 0; k--) arr[k] = F.pop(); return arr; },
    newObject: function (count) { var pairs = []; for (var k = 0; k < count; k++) { var vv = F.pop(); var kk = F.pop(); pairs.push([kk, vv]); } pairs.reverse(); var o = {}; for (var p = 0; p < pairs.length; p++) o[pairs[p][0]] = pairs[p][1]; return o; },
    indexGet: function (a, i) { if (a === null || a === undefined) return null; var v = a[i]; return v === undefined ? null : v; },
    indexSet: function (a, i, v) { if (a !== null && a !== undefined) a[i] = v; },
    len: function (a) { return (a === null || a === undefined) ? 0 : (a.length || 0); },
    host: function (name, count) {
      var args = new Array(count); for (var k = count - 1; k >= 0; k--) args[k] = F.pop();
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
    call: function (fnIdx, argc) {
      var fn = fns[fnIdx];
      var locals = mkLocals(fn.nlocals);
      var av = new Array(argc);
      for (var k = argc - 1; k >= 0; k--) av[k] = F.pop();
      for (var j = 0; j < argc && j < fn.nparams; j++) locals[j].v = av[j];
      frames.push(frame);
      frame = { code: fn.code, ip: 0, locals: locals, upvals: [] };
    },
    ret: function () {
      var rv = F.pop();
      if (frames.length === 0) { running = false; F.push(rv); return; }
      frame = frames.pop();
      F.push(rv);
    },
  };

  var steps = 0;
  var MAX = opts.maxSteps || 20000000;
  while (running) {
    if (++steps > MAX) throw new Error('resource limit: instruction budget exceeded');
    var op = frame.code[frame.ip++];
    var ex = execById[op];
    if (!ex) throw new Error('illegal opcode ' + op + ' at ip=' + (frame.ip - 1));
    ex(F);
  }
  return { output: out, steps: steps };
}

module.exports = { execProgramReg };
