'use strict';
// Differential conformance -- Prism's correctness gate. For every program:
//   1. interpreter output  (the spec oracle, backends/interp.js)
//   2. standalone-VM output (backends/emit-js.js, run in a sandbox)
//   3. the expected output
// All three must be byte-identical. Because both backends are generated from the
// one spec, "do the backends agree with the spec?" is the definition of green --
// the drift/oracle bug class that bit vm-gen cannot recur here.

const { compile } = require('../src/core/compiler');
const { interpret } = require('../src/backends/interp');
const { emitJs } = require('../src/backends/emit-js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
}

function runEmitted(code) {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log, origErr = console.error;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  console.log = (...a) => { lines.push(a.join(' ') + '\n'); };
  console.error = () => {};
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', 'process', 'console', code)(
      { exports: {} }, {}, require, process, console);
  } finally {
    process.stdout.write = origWrite; console.log = origLog; console.error = origErr;
  }
  return lines.join('').split('\n').filter((x) => x.length).map(String);
}

const cases = [
  { name: 'arithmetic + precedence', src: 'print 1 + 2 * 3 - 4;', expect: ['3'] },
  { name: 'string concat', src: 'print "a" + "b" + "c";', expect: ['abc'] },
  { name: 'mixed concat', src: 'print "n=" + (2 + 3);', expect: ['n=5'] },
  { name: 'let + reassign', src: 'let x = 5; x = x + 2; print x;', expect: ['7'] },
  { name: 'comparison + bool', src: 'print 3 < 5; print 5 <= 5; print 9 > 10;', expect: ['true', 'true', 'false'] },
  { name: 'if / else', src: 'let a = 7; if (a > 5) { print "big"; } else { print "small"; }', expect: ['big'] },
  { name: 'ternary', src: 'let a = 2; print a == 2 ? "two" : "other";', expect: ['two'] },
  { name: 'logical short-circuit', src: 'print (0 || "fallback"); print (1 && "reached");', expect: ['fallback', 'reached'] },
  { name: 'while loop sum', src: 'let i = 0; let s = 0; while (i < 5) { s = s + i; i = i + 1; } print s;', expect: ['10'] },
  { name: 'function call', src: 'function add(a, b){ return a + b; } print add(4, 38);', expect: ['42'] },
  { name: 'recursion (fib)', src: 'function fib(n){ if (n < 2) { return n; } return fib(n-1) + fib(n-2); } print fib(10);', expect: ['55'] },
  { name: 'console.log multi-arg', src: 'console.log("x", 1, true);', expect: ['x 1 true'] },
  { name: 'nested calls', src: 'function sq(n){ return n*n; } function f(n){ return sq(n) + 1; } print f(6);', expect: ['37'] },
  { name: 'array literal + index', src: 'let a = [10, 20, 30]; print a[1];', expect: ['20'] },
  { name: 'array set + length', src: 'let a = [1, 2, 3]; a[0] = 99; print a[0]; print len(a); print a.length;', expect: ['99', '3', '3'] },
  { name: 'array toString', src: 'print [1, 2, 3];', expect: ['[1, 2, 3]'] },
  { name: 'for loop sum', src: 'let s = 0; for (let i = 0; i < 5; i = i + 1) { s = s + i; } print s;', expect: ['10'] },
  { name: 'for over array', src: 'let a = [5, 10, 15, 20]; let s = 0; for (let i = 0; i < len(a); i = i + 1) { s = s + a[i]; } print s;', expect: ['50'] },
  { name: 'bubble sort', src: 'function sort(a){ let n = len(a); for (let i = 0; i < n; i = i + 1) { for (let j = 0; j < n - 1; j = j + 1) { if (a[j] > a[j+1]) { let t = a[j]; a[j] = a[j+1]; a[j+1] = t; } } } return a; } print sort([5, 2, 8, 1, 9, 3]);', expect: ['[1, 2, 3, 5, 8, 9]'] },
  { name: 'object literal + member', src: 'let o = { a: 1, b: 2 }; print o.a; print o.b;', expect: ['1', '2'] },
  { name: 'object set + toString', src: 'let o = { name: "vm" }; o.count = 5; print o;', expect: ['{name: vm, count: 5}'] },
  { name: 'array of objects', src: 'let a = [{ n: 1 }, { n: 2 }]; print a[0].n + a[1].n;', expect: ['3'] },
  { name: 'host: Math + bare builtins', src: 'print Math.floor(3.7); print max(3, 9, 5); print min(4, 2, 8); print abs(-7); print sqrt(16); print pow(2, 10);', expect: ['3', '9', '2', '7', '4', '1024'] },
  { name: 'host: hypotenuse', src: 'let p = { x: 3, y: 4 }; print sqrt(p.x * p.x + p.y * p.y);', expect: ['5'] },
  { name: 'closure: adder', src: 'function makeAdder(x){ return fn(y){ return x + y; }; } let add5 = makeAdder(5); print add5(10);', expect: ['15'] },
  { name: 'closure: shared mutation (counter)', src: 'function makeCounter(){ let c = 0; return fn(){ c = c + 1; return c; }; } let n = makeCounter(); print n(); print n(); print n();', expect: ['1', '2', '3'] },
  { name: 'higher-order: apply', src: 'function apply(f, v){ return f(v); } function dbl(x){ return x * 2; } print apply(dbl, 21);', expect: ['42'] },
  { name: 'curried call', src: 'let mul = fn(a){ return fn(b){ return a * b; }; }; print mul(6)(7);', expect: ['42'] },
  { name: 'nested named recursion', src: 'function outer(){ let c = 0; function inc(){ c = c + 1; return c; } return inc; } let g = outer(); print g(); print g();', expect: ['1', '2'] },
  { name: 'closures in an array', src: 'let fns = [fn(x){ return x + 1; }, fn(x){ return x * x; }]; print fns[0](10); print fns[1](7);', expect: ['11', '49'] },
];

console.log('== Prism differential conformance ==');
for (const c of cases) {
  let interpOut, emitOut;
  try { interpOut = interpret(compile(c.src)).output; } catch (e) { interpOut = ['<throw> ' + e.message]; }
  try { emitOut = runEmitted(emitJs(compile(c.src), { banner: false })); } catch (e) { emitOut = ['<throw> ' + e.message]; }
  const oracleOk = JSON.stringify(interpOut) === JSON.stringify(c.expect);
  const agreeOk = JSON.stringify(interpOut) === JSON.stringify(emitOut);
  ok('interp ' + c.name, oracleOk, `got ${JSON.stringify(interpOut)} want ${JSON.stringify(c.expect)}`);
  ok('emit≡interp ' + c.name, agreeOk, `emit=${JSON.stringify(emitOut)} interp=${JSON.stringify(interpOut)}`);
}

// ---- obfuscation must never change behavior ----
// Every case, rebuilt with the bogus-stack obfuscation pass at level 2, must
// still produce interpreter ≡ emitted ≡ expected. This is the safety contract
// that lets obfuscation passes be added freely.
console.log('\n== with obfuscation (protect.bogus = 2) ==');
for (const c of cases) {
  const opt = { optimize: true, protect: { bogus: 2 }, seed: 1234 };
  let io, eo;
  try { io = interpret(compile(c.src, opt)).output; } catch (e) { io = ['<throw> ' + e.message]; }
  try { eo = runEmitted(emitJs(compile(c.src, opt), { banner: false })); } catch (e) { eo = ['<throw> ' + e.message]; }
  ok('obf ' + c.name, JSON.stringify(io) === JSON.stringify(c.expect) && JSON.stringify(eo) === JSON.stringify(c.expect),
    `interp=${JSON.stringify(io)} emit=${JSON.stringify(eo)}`);
}

// ---- decoy functions must never change behavior ----
// Every case, rebuilt with decoy functions appended, must still produce
// interpreter ≡ emitted ≡ register ≡ expected. Decoys are unreachable (no real
// instruction targets their indices), so this holds by construction -- the gate
// proves it across machine models. A structural check confirms decoys are really
// present and that no real code references a decoy index.
console.log('\n== with decoys (protect.decoys = 3) ==');
{
  const { interpretReg: _ireg } = require('../src/backends/emit-js-reg');
  const { opWidth: _ow, OP: _OP, OPS: _OPS } = require('../src/core/spec');
  for (const c of cases) {
    const opt = { protect: { decoys: 3, decoyStrength: 3 }, seed: 999 };
    let io, eo, ro, base;
    try { base = compile(c.src, { seed: 999 }); } catch (e) { base = null; }
    let img; try { img = compile(c.src, opt); } catch (e) { img = null; }
    try { io = interpret(img).output; } catch (e) { io = ['<throw> ' + e.message]; }
    try { eo = runEmitted(emitJs(img, { banner: false })); } catch (e) { eo = ['<throw> ' + e.message]; }
    try { ro = _ireg(img).output; } catch (e) { ro = ['<throw> ' + e.message]; }
    const grew = base && img && img.functions.length === base.functions.length + 3;
    ok('decoy ' + c.name, grew
      && JSON.stringify(io) === JSON.stringify(c.expect)
      && JSON.stringify(eo) === JSON.stringify(c.expect)
      && JSON.stringify(ro) === JSON.stringify(c.expect),
      `grew=${grew} interp=${JSON.stringify(io)} emit=${JSON.stringify(eo)} reg=${JSON.stringify(ro)}`);
  }
  // structural: the appended decoys are unreferenced by any real function's code.
  const img = compile('function f(n){ return n + 1; } print f(41);', { protect: { decoys: 4 }, seed: 5 });
  const realCount = img.functions.length - 4;
  const targeted = new Set();
  for (let fi = 0; fi < realCount; fi++) {
    const code = img.functions[fi].code;
    for (let p = 0; p < code.length; ) {
      const op = code[p];
      if (op === _OP.CALL || op === _OP.CLOSURE) targeted.add(code[p + 1] | (code[p + 2] << 8));
      p += _ow(op);
    }
  }
  let anyDecoyTargeted = false;
  for (let di = realCount; di < img.functions.length; di++) if (targeted.has(di)) anyDecoyTargeted = true;
  ok('decoys are present and unreferenced', realCount === 2 && !anyDecoyTargeted && img.functions.length === 6, `targeted=${[...targeted]}`);
}

// ---- inline <@protect> pragma ----
// Protection requested in source must resolve to the same build as the equivalent
// explicit options, be stripped before parsing, and yield to explicit overrides.
console.log('\n== inline <@protect> pragma ==');
{
  const inlineSrc = '<@protect encrypt permute decoys=2 seed=77 backend=js>\nfunction f(n){ return n * 2; }\nprint f(21);';
  const plainSrc = 'function f(n){ return n * 2; }\nprint f(21);';
  const a = emitJs(compile(inlineSrc), { banner: false });
  const b = emitJs(compile(plainSrc, { encryptConsts: true, permute: true, protect: { decoys: 2 }, seed: 77 }), { banner: false });
  ok('pragma ≡ equivalent explicit opts (byte-identical)', a === b);
  ok('pragma build runs correctly', JSON.stringify(runEmitted(a)) === JSON.stringify(['42']));
  ok('pragma is stripped before parse', JSON.stringify(interpret(compile(inlineSrc)).output) === JSON.stringify(['42']));
  // explicit opts override the inline pragma
  const img = compile('<@protect decoys=5>\nprint 1;');
  const imgOverride = compile('<@protect decoys=5>\nprint 1;', { protect: { decoys: 0 } });
  ok('explicit opts override inline pragma', img.functions.length === 6 && imgOverride.functions.length === 1);
  // inline backend selection reaches api.build
  const built = require('../src/api').build('<@protect backend=lua>\nprint 7;');
  ok('inline backend= selects the target', built.meta.target === 'lua' && built.code.indexOf('standalone Lua VM') !== -1);
  // an unknown pragma token fails loudly
  let threw = false; try { compile('<@protect nonsense>\nprint 1;'); } catch (_) { threw = true; }
  ok('unknown pragma token throws', threw);
}

// ---- a third-party pass plugs in without touching core ----
// A custom pass (net-zero DUP;POP churn) registered via opts.plugins must run and
// keep semantics intact -- the extensibility seam, proven.
console.log('\n== custom plugin pass ==');
const { definePlugin } = require('../src/core/plugin');
const { OP } = require('../src/core/spec');
const myPass = definePlugin({
  kind: 'pass', name: 'dup-pop-churn', stage: 'obfuscate',
  run(fn) {
    const out = [];
    for (const ins of fn.instrs) { out.push(ins); if (ins.op === OP.LOAD) { out.push({ op: OP.DUP, args: [] }); out.push({ op: OP.POP, args: [] }); } }
    fn.instrs = out;
  },
});
{
  const src = 'function f(n){ return n + n; } print f(21);';
  const img = compile(src, { optimize: true, plugins: [myPass], seed: 3 });
  const io = interpret(img).output;
  ok('custom pass runs & preserves semantics', JSON.stringify(io) === JSON.stringify(['42']), `got ${JSON.stringify(io)}`);
}

// ---- versioned binary image: round-trip, integrity, cipher ----
console.log('\n== binary image (versioned + protected) ==');
const { encodeImage, decodeImage } = require('../src/core/image');
for (const c of cases) {
  const img = compile(c.src, { seed: 77 });
  let rt;
  try { rt = interpret(decodeImage(encodeImage(img, { seed: 77 }))).output; } catch (e) { rt = ['<throw> ' + e.message]; }
  ok('encode→decode→run ' + c.name, JSON.stringify(rt) === JSON.stringify(c.expect), `got ${JSON.stringify(rt)}`);
}
{
  // integrity domain: a flipped body byte must be rejected at decode.
  const bytes = encodeImage(compile('print 1+1;', { seed: 5 }), { seed: 5 });
  bytes[bytes.length - 2] ^= 0xff;
  let rejected = false;
  try { decodeImage(bytes); } catch (_) { rejected = true; }
  ok('tampered body rejected', rejected);
  // header meta is in the integrity domain too: flipping a seed byte is caught.
  const hb = encodeImage(compile('print 1+1;', { seed: 5 }), { seed: 5 });
  hb[7] ^= 0xff; // a key-seed byte (bytes 7..10)
  let hrej = false;
  try { decodeImage(hb); } catch (_) { hrej = true; }
  ok('tampered header (key seed) rejected', hrej);
  // constant-pool cipher: a plaintext literal must not appear in the artifact.
  const code = emitJs(compile('print "TOPSECRET_TOKEN";', { seed: 5 }), { seed: 5, banner: false });
  ok('constant literal encrypted out of artifact', code.indexOf('TOPSECRET_TOKEN') === -1);
  // and the encrypted artifact still runs correctly.
  ok('encrypted artifact runs', JSON.stringify(runEmitted(code)) === JSON.stringify(['TOPSECRET_TOKEN']));
}

// ---- integrity kind: signing (keyed MAC) ----
console.log('\n== signing (integrity kind: fnv1a-mac) ==');
for (const c of cases) {
  const opt = { seed: 88, protect: { sign: true } };
  let rt, eo;
  try { rt = interpret(decodeImage(encodeImage(compile(c.src, opt), opt))).output; } catch (e) { rt = ['<throw> ' + e.message]; }
  try { eo = runEmitted(emitJs(compile(c.src, opt), Object.assign({ banner: false }, opt))); } catch (e) { eo = ['<throw> ' + e.message]; }
  ok('signed ' + c.name, JSON.stringify(rt) === JSON.stringify(c.expect) && JSON.stringify(eo) === JSON.stringify(c.expect), `rt=${JSON.stringify(rt)} emit=${JSON.stringify(eo)}`);
}
{
  // a signed image sets the signed flag, keys the digest, and is still tamper-evident.
  const signed = encodeImage(compile('print 42;', { seed: 9 }), { seed: 9, protect: { sign: true } });
  const plain = encodeImage(compile('print 42;', { seed: 9 }), { seed: 9 });
  ok('signed flag + sign key present', (signed[4] & 4) !== 0 && (plain[4] & 4) === 0 && signed.slice(11, 15).some((b, i) => b !== plain[11 + i]));
  ok('signed digest differs from plain', signed.slice(15, 19).join(',') !== plain.slice(15, 19).join(','));
  const t = signed.slice(); t[t.length - 1] ^= 0xff;
  let rej = false; try { decodeImage(t); } catch (_) { rej = true; }
  ok('tampered signed image rejected', rej);
}

// ---- cipher & integrity kinds: third-party algorithms embed and round-trip ----
console.log('\n== custom cipher + integrity (embedded in the artifact) ==');
{
  const { definePlugin: dp } = require('../src/core/plugin');
  // a byte-rotate cipher (id >= 16) with a pure, embeddable decode
  const rotCipher = dp({
    kind: 'cipher', name: 'rot', id: 20,
    encode(blob, seed) { const k = (seed & 7) + 1; for (let i = 0; i < blob.length; i++) blob[i] = (blob[i] + k) & 0xff; },
    decode(blob, seed) { const k = (seed & 7) + 1; for (let i = 0; i < blob.length; i++) blob[i] = (blob[i] - k) & 0xff; },
  });
  // a custom integrity (id >= 16): a simple additive rolling digest
  const sumIntegrity = dp({
    kind: 'integrity', name: 'sum32', id: 21, signed: false,
    digest(bytes) { let h = 0x1234 >>> 0; for (let i = 0; i < bytes.length; i++) { h = (Math.imul(h, 31) + bytes[i]) >>> 0; } return h >>> 0; },
  });
  const opt = { seed: 123, protect: { cipher: 'rot', integrity: 'sum32' }, plugins: [rotCipher, sumIntegrity] };
  // in-process round-trip
  let rt; try { rt = interpret(decodeImage(encodeImage(compile('print "HELLO"; print 6*7;', opt), opt),
    { ciphers: { 20: rotCipher.decode }, integrities: { 21: sumIntegrity.digest } })).output; } catch (e) { rt = ['<throw> ' + e.message]; }
  ok('custom cipher+integrity round-trip', JSON.stringify(rt) === JSON.stringify(['HELLO', '42']), `got ${JSON.stringify(rt)}`);
  // standalone JS artifact embeds the custom decode/digest and runs
  const code = emitJs(compile('print "HELLO"; print 6*7;', opt), Object.assign({ banner: false }, opt));
  ok('custom decode/digest embedded in artifact', code.indexOf('ciphers:') !== -1 && code.indexOf('integrities:') !== -1);
  ok('custom-protected artifact runs', JSON.stringify(runEmitted(code)) === JSON.stringify(['HELLO', '42']), `got ${JSON.stringify(runEmitted(code))}`);
  // custom integrity is tamper-evident in the standalone artifact too
  const bytes = encodeImage(compile('print 1;', opt), opt);
  bytes[bytes.length - 1] ^= 0xff;
  let rej = false; try { decodeImage(bytes, { ciphers: { 20: rotCipher.decode }, integrities: { 21: sumIntegrity.digest } }); } catch (_) { rej = true; }
  ok('custom integrity rejects tamper', rej);
}

// ---- opcode permutation (protection): emitted VM ≡ canonical interpreter ----
console.log('\n== opcode permutation (protection) ==');
for (const c of cases) {
  let out;
  try { out = runEmitted(emitJs(compile(c.src), { banner: false, permute: true, encryptConsts: true, seed: 4242 })); } catch (e) { out = ['<throw> ' + e.message]; }
  ok('permuted ' + c.name, JSON.stringify(out) === JSON.stringify(c.expect), `got ${JSON.stringify(out)}`);
}
{
  // the stored dispatch bytes must actually change under permutation
  const { encodeImage } = require('../src/core/image');
  const img = compile('print 1 + 1;');
  const plain = encodeImage(img, { seed: 4242 });
  const perm = encodeImage(img, { seed: 4242, permute: true });
  let diff = 0; for (let i = 0; i < Math.min(plain.length, perm.length); i++) if (plain[i] !== perm[i]) diff++;
  ok('permutation changes dispatch bytes', diff > 0 && (perm[4] & 2) !== 0, `diff=${diff}`);
}

// ---- second MACHINE MODEL from the same spec: register machine ----
// The register machine stores the operand stack in a register file + stack
// pointer (optionally masked). Same sem-generated handlers; must still agree.
console.log('\n== register machine (same spec, different model) ==');
const { emitJsReg, interpretReg } = require('../src/backends/emit-js-reg');
for (const c of cases) {
  let regO, regEncO, standO;
  try { regO = interpretReg(compile(c.src)).output; } catch (e) { regO = ['<throw> ' + e.message]; }
  try { regEncO = interpretReg(compile(c.src), { encrypted: true, seed: 42 }).output; } catch (e) { regEncO = ['<throw> ' + e.message]; }
  try { standO = runEmitted(emitJsReg(compile(c.src), { banner: false, encrypted: true, seed: 42 })); } catch (e) { standO = ['<throw> ' + e.message]; }
  ok('register ' + c.name, JSON.stringify(regO) === JSON.stringify(c.expect)
    && JSON.stringify(regEncO) === JSON.stringify(c.expect)
    && JSON.stringify(standO) === JSON.stringify(c.expect),
    `reg=${JSON.stringify(regO)} enc=${JSON.stringify(regEncO)} standalone=${JSON.stringify(standO)}`);
}

// ---- second target LANGUAGE from the same spec: Lua ----
// The Lua VM's opcode handlers are lowered from the identical `sem` the JS
// backends use. If Lua ≡ interpreter across the corpus, "one spec, many machines"
// holds across languages. Uses fengari if available (skipped, not failed, if not).
let fengari = null;
try { fengari = require('../../vm-gen/node_modules/fengari'); } catch (_) { /* optional */ }
if (fengari) {
  const { emitLua } = require('../src/backends/emit-lua');
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const runLua = (code) => {
    const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
    const lines = [];
    lua.lua_pushcfunction(L, (L2) => { const n = lua.lua_gettop(L2); const parts = []; for (let i = 1; i <= n; i++) parts.push(lua.lua_tojsstring(L2, i)); lines.push(parts.join('\t')); return 0; });
    lua.lua_setglobal(L, to_luastring('print'));
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) return ['<lua error> ' + lua.lua_tojsstring(L, -1)];
    return lines;
  };
  console.log('\n== Lua backend (generated from the same spec) ==');
  for (const c of cases) {
    let lo, ld;
    try { lo = runLua(emitLua(compile(c.src), { banner: false })); } catch (e) { lo = ['<throw> ' + e.message]; }
    // decoys must be output-neutral on the Lua machine too
    try { ld = runLua(emitLua(compile(c.src, { protect: { decoys: 3, decoyStrength: 3 }, seed: 999 }), { banner: false })); } catch (e) { ld = ['<throw> ' + e.message]; }
    ok('lua ' + c.name, JSON.stringify(lo) === JSON.stringify(c.expect) && JSON.stringify(ld) === JSON.stringify(c.expect), `got ${JSON.stringify(lo)} decoy=${JSON.stringify(ld)}`);
  }
} else {
  console.log('\n== Lua backend == (skipped: fengari not installed)');
}

// ---- third target LANGUAGE from the same spec: Python ----
// The Python VM's opcode handlers are lowered from the identical `sem` the JS and
// Lua backends use. If Python ≡ interpreter across the corpus (and stays neutral
// under decoys), "one spec, many machines" holds across a third language. Spawns
// `python`/`python3` if available (skipped, not failed, if not).
const cp = require('child_process');
const os = require('os');
const pathlib = require('path');
const fslib = require('fs');
const { emitPy } = require('../src/backends/emit-py');
let pyCmd = null;
for (const cand of ['python', 'python3']) {
  try { cp.execFileSync(cand, ['--version'], { stdio: 'ignore' }); pyCmd = cand; break; } catch (_) { /* try next */ }
}
if (pyCmd) {
  const runPy = (code) => {
    const tmp = pathlib.join(os.tmpdir(), 'prism_conf_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.py');
    fslib.writeFileSync(tmp, code);
    try { return cp.execFileSync(pyCmd, [tmp], { encoding: 'utf8' }).replace(/\r/g, '').split('\n').filter((x) => x.length); }
    catch (e) { return ['<py error> ' + (e.stderr || e.message)]; }
    finally { try { fslib.unlinkSync(tmp); } catch (_) { /* ignore */ } }
  };
  console.log('\n== Python backend (generated from the same spec) ==');
  for (const c of cases) {
    let po, pd;
    try { po = runPy(emitPy(compile(c.src), { banner: false })); } catch (e) { po = ['<throw> ' + e.message]; }
    try { pd = runPy(emitPy(compile(c.src, { protect: { decoys: 3, decoyStrength: 3 }, seed: 999 }), { banner: false })); } catch (e) { pd = ['<throw> ' + e.message]; }
    ok('py ' + c.name, JSON.stringify(po) === JSON.stringify(c.expect) && JSON.stringify(pd) === JSON.stringify(c.expect), `got ${JSON.stringify(po)} decoy=${JSON.stringify(pd)}`);
  }
} else {
  console.log('\n== Python backend == (skipped: python not found)');
}

// determinism: same source builds byte-identical
const a = emitJs(compile('print 1+1;'), { banner: false });
const b = emitJs(compile('print 1+1;'), { banner: false });
ok('deterministic build', a === b);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
