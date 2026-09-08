'use strict';
// Fuzzer.  node test/fuzz.js [iterations]
//   1. front-end: garbage source must fail gracefully (a thrown Error is fine; a
//      hang or a non-Error crash is not).
//   2. differential: random VALID programs must produce identical output on the
//      interpreter and the fully-protected emitted VM (permuted + encrypted).
//   3. image: a mutated binary image must be rejected by the integrity domain or
//      fail with an Error -- and must never reproduce the clean output (bypass).

const { compile } = require('../src/core/compiler');
const { interpret } = require('../src/backends/interp');
const { emitJs } = require('../src/backends/emit-js');
const { encodeImage, decodeImage } = require('../src/core/image');
const { execProgram } = require('../src/core/machine');
const { OPS } = require('../src/core/spec');
const { jsBody } = require('../src/core/codegen');
const execById = OPS.map((o) => new Function('F', jsBody(o.sem))); // eslint-disable-line no-new-func

const ITERS = parseInt(process.argv[2], 10) || 1500;
let checks = 0, problems = 0;
const fail = (m) => { problems++; console.log('  PROBLEM: ' + m); };
let s = 0x1234567;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];

function runEmitted(code) {
  const lines = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (x) => { lines.push(String(x)); return true; };
  try { new Function('process', code)(process); } catch (e) { process.stdout.write = w; return { threw: true }; } finally { process.stdout.write = w; } // eslint-disable-line no-new-func
  return { lines: lines.join('').split('\n').filter((x) => x.length) };
}

// ---- 1. front-end fuzz ----
const CHUNKS = ['let', 'fn', 'function', 'return', 'if', 'else', 'while', 'for', 'print', 'true', 'false',
  'null', '(', ')', '{', '}', '[', ']', ';', ',', '=', '==', '+', '-', '*', '/', '<', '>', '&&', '||', '!',
  '.', 'x', 'foo', '0', '1', '42', '"s"', '\n', ' ', '<@', '@>'];
console.log('== front-end fuzz ==');
for (let k = 0; k < ITERS; k++) {
  let src = ''; const n = 1 + int(30); for (let i = 0; i < n; i++) src += pick(CHUNKS);
  checks++;
  try { compile(src); } catch (e) { if (!(e instanceof Error)) fail('non-Error on garbage: ' + JSON.stringify(src)); }
}

// ---- 2. differential fuzz on random valid programs ----
function expr(d) {
  if (d <= 0 || rnd() < 0.4) return String(1 + int(20));
  return '(' + expr(d - 1) + ' ' + pick(['+', '-', '*']) + ' ' + expr(d - 1) + ')';
}
function program() {
  const parts = [];
  const nv = int(3);
  const vars = [];
  for (let i = 0; i < nv; i++) { const v = 'v' + i; vars.push(v); parts.push('let ' + v + ' = ' + expr(2) + ';'); }
  const term = vars.length && rnd() < 0.5 ? pick(vars) : expr(3);
  if (rnd() < 0.5) parts.push('let s = 0; for (let i = 0; i < ' + (1 + int(6)) + '; i = i + 1) { s = s + i; } print s;');
  parts.push('print ' + term + ';');
  return parts.join('\n');
}
console.log('== differential fuzz (interp == protected VM) ==');
for (let k = 0; k < Math.floor(ITERS / 3); k++) {
  const src = program();
  checks++;
  let a, b;
  try { a = interpret(compile(src)).output; } catch (e) { a = ['<e>']; }
  try { const r = runEmitted(emitJs(compile(src), { banner: false, permute: true, encryptConsts: true, seed: int(1e9) })); b = r.threw ? ['<e>'] : r.lines; } catch (e) { b = ['<e>']; }
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('divergence on: ' + JSON.stringify(src) + ' a=' + JSON.stringify(a) + ' b=' + JSON.stringify(b));
}

// ---- 2b. decoy fuzz: decoys must stay output-neutral on random programs ----
// Each random program, rebuilt with decoys, must match the un-decoyed interpreter
// on interp / register / emit-js. Decoys are unreachable, so any divergence is a
// real bug (e.g. an index collision). In-process only -- no external runtime.
const { interpretReg } = require('../src/backends/emit-js-reg');
console.log('== decoy fuzz (decoys are output-neutral) ==');
for (let k = 0; k < Math.floor(ITERS / 3); k++) {
  const src = program();
  checks++;
  let base, io, ro, jo;
  try { base = interpret(compile(src)).output; } catch (e) { base = ['<e>']; }
  const opt = { protect: { decoys: 1 + int(4), decoyStrength: 1 + int(3) }, seed: int(1e9) };
  try { io = interpret(compile(src, opt)).output; } catch (e) { io = ['<e>']; }
  try { ro = interpretReg(compile(src, opt)).output; } catch (e) { ro = ['<e>']; }
  try { const r = runEmitted(emitJs(compile(src, opt), { banner: false })); jo = r.threw ? ['<e>'] : r.lines; } catch (e) { jo = ['<e>']; }
  const b = JSON.stringify(base);
  if (JSON.stringify(io) !== b || JSON.stringify(ro) !== b || JSON.stringify(jo) !== b) {
    fail('decoy divergence on: ' + JSON.stringify(src) + ' base=' + b + ' interp=' + JSON.stringify(io) + ' reg=' + JSON.stringify(ro) + ' emit=' + JSON.stringify(jo));
  }
}

// ---- 3. image fuzz (integrity / controlled failure) ----
console.log('== image fuzz (tamper) ==');
const base = compile('function f(n){ if(n<2){return n;} return f(n-1)+f(n-2);} let a=[1,2,3]; print f(8); print a[1];');
const clean = interpret(base).output;
const cleanBytes = encodeImage(base, { seed: 7, permute: true, encryptConsts: true, protect: { sign: true } });
for (let k = 0; k < Math.floor(ITERS / 3); k++) {
  const img = cleanBytes.slice();
  const muts = 1 + int(4);
  for (let m = 0; m < muts; m++) { const i = int(img.length); img[i] = (img[i] ^ (1 + int(255))) & 0xff; }
  checks++;
  let dec = null, outcome = 'ran', out = null;
  try { dec = decodeImage(img); } catch (e) { outcome = (e instanceof Error) ? 'rejected' : 'CRASH'; }
  if (dec) {
    try { out = execProgram(dec, execById, { maxSteps: 2000000 }).output; }
    catch (e) { outcome = (e instanceof Error) ? 'rejected' : 'CRASH'; }
  }
  if (outcome === 'CRASH') fail('non-Error crash on mutated image');
  if (outcome === 'ran' && JSON.stringify(out) === JSON.stringify(clean) && JSON.stringify(img) !== JSON.stringify(cleanBytes)) {
    fail('mutated image reproduced clean output (integrity bypass)');
  }
}

console.log(`\n${checks} inputs exercised, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
