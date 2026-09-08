'use strict';
// Front-end robustness + dud-code regression test.
//
//   node tests/parse-and-dud.test.js
//
// Part 1 verifies the compiler front-end (lex -> parse -> bytecode) accepts a
// batch of real-world JavaScript constructs without throwing, at both
// optimization levels. Part 2 verifies dud-code injection appends inert decoy
// functions to the image without changing behaviour or breaking integrity.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compile } = require('../src/compiler');
const { generate } = require('../src/generate');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// Part 1: parse/compile robustness for real JS constructs.
// NOTE: the regex below intentionally contains a `/` inside a `[...]` character
// class -- the lexer must not treat it as the closing delimiter.
// ---------------------------------------------------------------------------
const CONSTRUCTS = {
  'member chain + regex char-class':
    "const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\\\])+/, ''));",
  'string literals that look like comments':
    "console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^ \\* ?/gm, ''));",
  'uninitialized let': 'let JsObfuscator;',
  'template literal with interpolation': 'let a = `${test}`;',
  'object method + this + template': 'let o = { name: "x", speak() { return `${this.name} speaks`; } };',
  'empty template literal': 'let e = ``;',
  'throw new Error(err)': 'let err = "boom"; throw new Error(err);',
  'undefined value + shorthand in table': 'let sandbox = { x:2, y:3, result: undefined, console };',
  'async function declaration + call': 'async function test(){} test();',
};

console.log('== front-end accepts real JS constructs ==');
for (const [name, src] of Object.entries(CONSTRUCTS)) {
  let okOpt = true, err = '';
  for (const optimize of [false, true]) {
    try { compile(src, { optimize }); }
    catch (e) { okOpt = false; err = `(optimize=${optimize}) ` + e.message; }
  }
  ok(name, okOpt, err);
}

// ---------------------------------------------------------------------------
// Part 2: dud-code injection.
// ---------------------------------------------------------------------------
console.log('== dud-code injection ==');
const PROG = 'fn fib(n){ if(n<2){return n;} return fib(n-1)+fib(n-2); } for(let i=0;i<=6;i=i+1){ print fib(i); }';
const SEED = 4242;

const base = generate(PROG, { target: 'js', profile: 'balanced', seed: SEED, dud: false, banner: false });
const dud = generate(PROG, { target: 'js', profile: 'balanced', seed: SEED, dud: true, dudCount: 4, banner: false });

ok('duds are appended to the function table', dud.meta.dudFns === 4, `dudFns=${dud.meta.dudFns}`);
ok('real function count is unchanged', dud.meta.realFns === base.meta.realFns,
   `real=${dud.meta.realFns} base=${base.meta.realFns}`);
ok('dud image is larger than the plain image', dud.meta.imageSize > base.meta.imageSize,
   `dud=${dud.meta.imageSize} base=${base.meta.imageSize}`);

// The injected image must still pass every integrity domain and run correctly --
// decoy functions are never called, so output must be identical to the plain build.
function runJs(source) {
  const file = path.join(__dirname, `_tmp_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, source);
  const out = require('child_process').execFileSync(process.execPath, [file], { encoding: 'utf8' });
  fs.unlinkSync(file);
  return out.trim();
}
const EXPECTED = '0\n1\n1\n2\n3\n5\n8';
let dudOut = '', baseOut = '', runErr = '';
try { baseOut = runJs(base.output); dudOut = runJs(dud.output); }
catch (e) { runErr = e.message; }
ok('plain build runs correctly', baseOut === EXPECTED, runErr || JSON.stringify(baseOut));
ok('dud build runs correctly (decoys inert, integrity intact)', dudOut === EXPECTED, runErr || JSON.stringify(dudOut));

// A dud build for the Lua target must assemble without error too.
let luaOk = true, luaErr = '';
try { generate(PROG, { target: 'lua', profile: 'aggressive', seed: SEED, banner: false }); }
catch (e) { luaOk = false; luaErr = e.message; }
ok('aggressive Lua build (dud default on) assembles', luaOk, luaErr);

console.log(`\nparse-and-dud: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
