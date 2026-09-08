'use strict';
// vm-gen test suite.
//   * compiles each example, runs the JS backend, checks expected output
//   * builds the Lua backend and runs it through fengari, checks parity
//   * verifies the tamper/integrity check trips when the image is modified
//   * verifies deterministic builds and the per-seed "moving target" property
//
// Lua execution uses fengari if installed; otherwise Lua parity is skipped
// with a warning (JS coverage still runs).

const fs = require('fs');
const path = require('path');
const { generate, buildImage, compile } = require('../src/generate');
const { emitJs } = require('../src/emit-js');
const { interpret } = require('../src/interp');

let fengari = null;
try { fengari = require('fengari'); } catch (_) { /* optional */ }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -- ' + extra : ''}`); }
}

// Run a generated standalone JS module, capturing stdout lines.
function runJs(source, seed) {
  const { output } = generate(source, { target: 'js', banner: false, seed });
  return captureStdout(() => {
    new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', output)(
      { exports: {} }, {}, require, process, console, Buffer);
  });
}

// Run generated JS from an explicit image (used by the tamper test). The salt
// (from buildImage's meta) lets the VM recover the derived seeds/permutation.
function runJsImage(image, salt) {
  const output = emitJs(image, { banner: false, salt: salt });
  return captureStdout(() => {
    new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', output)(
      { exports: {} }, {}, require, process, console, Buffer);
  });
}

function runLua(source, seed) {
  if (!fengari) return null;
  const { output } = generate(source, { target: 'lua', banner: false, seed });
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  return captureStdout(() => {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    if (lauxlib.luaL_dostring(L, to_luastring(output)) !== lua.LUA_OK) {
      throw new Error('lua: ' + lua.lua_tojsstring(L, -1));
    }
  });
}

function captureStdout(fn) {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origExit = process.exit;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  console.log = (...a) => { lines.push(a.join(' ') + '\n'); };
  process.exit = (code) => { throw new Error('__exit__:' + code); };
  try { fn(); }
  finally { process.stdout.write = origWrite; console.log = origLog; process.exit = origExit; }
  return lines.join('').split('\n').filter((l) => l.length > 0);
}

// ---- fixtures ----
const cases = [
  {
    name: 'arithmetic + strings',
    src: 'let a = 6; let b = 7; print "a*b=" + str(a*b); print (a+b)*2;',
    expect: ['a*b=42', '26'],
  },
  {
    name: 'branching + while',
    src: 'let i = 0; let s = 0; while (i < 5) { if (i % 2 == 0) { s = s + i; } i = i + 1; } print s;',
    expect: ['6'],
  },
  {
    name: 'recursion',
    src: 'fn fact(n){ if (n<=1){return 1;} return n*fact(n-1);} print fact(6);',
    expect: ['720'],
  },
  {
    name: 'logical short-circuit',
    src: 'let t = true; let f = false; print (t && f) || t; print !f;',
    expect: ['true', 'true'],
  },
  {
    name: 'arrays + host',
    src: 'let a = [3,1,2]; a = push(a, 9); print len(a); print a[3]; print str(a);',
    expect: ['4', '9', '[3, 1, 2, 9]'],
  },
  {
    name: 'for + break + continue',
    src: 'let t=0; for(let i=0;i<10;i=i+1){ if(i==3){continue;} if(i==7){break;} t+=i; } print t;',
    expect: ['18'],
  },
  {
    name: 'compound assignment + increment',
    src: 'let x=5; x*=3; x++; x-=1; print x;',
    expect: ['15'],
  },
  {
    name: 'ternary',
    src: 'let y=4; print y>3?"big":"small"; print (y==0)?"z":str(y*2);',
    expect: ['big', '8'],
  },
  {
    name: 'js-subset input (function/const/console.log)',
    src: 'function sq(n){ return n*n; } const k = 6; console.log("sq", sq(k));',
    expect: ['sq 36'],
  },
  {
    name: 'constant folding preserves value',
    src: 'print 2 + 3 * 4; let a=10; let b=a*2+1; print b;',
    expect: ['14', '21'],
  },
  {
    name: 'objects + property access',
    src: 'let o = {name:"vm", n:3}; print o.name; o.n = o.n + 1; print o["n"]; print len(o); print has(o,"name");',
    expect: ['vm', '4', '2', 'true'],
  },
  {
    name: 'closures (shared mutation, survives return)',
    src: 'fn make(){ let c=0; return fn(){ c=c+1; return c; }; } let g=make(); print g(); print g(); fn adder(x){ return fn(y){ return x+y; }; } print adder(5)(10);',
    expect: ['1', '2', '15'],
  },
  {
    name: 'anonymous functions + call value + method',
    src: 'let sq = fn(n){ return n*n; }; print sq(6); let o = {twice: fn(n){ return n*2; }}; print o.twice(21);',
    expect: ['36', '42'],
  },
  {
    name: 'exceptions (try/catch/finally)',
    src: 'try { throw "boom"; print "no"; } catch(e){ print "caught " + e; } finally { print "done"; }',
    expect: ['caught boom', 'done'],
  },
  {
    name: 'selective virtualization annotations',
    src: '@native\nfn a(x){ return x+1; }\n<@virtualize heavy>\nfn b(x){ return x*2; }\nprint a(4); print b(4);',
    expect: ['5', '8'],
  },
];

console.log('== JS backend ==');
for (const c of cases) {
  let out;
  try { out = runJs(c.src, 123); } catch (e) { out = ['<throw> ' + e.message]; }
  ok(c.name, JSON.stringify(out) === JSON.stringify(c.expect), `got ${JSON.stringify(out)}`);
}

console.log(fengari ? '== Lua backend (fengari) ==' : '== Lua backend SKIPPED (fengari not installed) ==');
if (fengari) {
  for (const c of cases) {
    let out;
    try { out = runLua(c.src, 123); } catch (e) { out = ['<throw> ' + e.message]; }
    ok(c.name, JSON.stringify(out) === JSON.stringify(c.expect), `got ${JSON.stringify(out)}`);
  }
}

console.log('== JS/Lua parity on examples ==');
if (fengari) {
  for (const f of ['hello', 'fib', 'arrays']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'examples', f + '.vgs'), 'utf8');
    const j = runJs(src, 99);
    const l = runLua(src, 99);
    ok('parity ' + f, JSON.stringify(j) === JSON.stringify(l), `js=${JSON.stringify(j)} lua=${JSON.stringify(l)}`);
  }
}

console.log('== integrity / tamper detection ==');
{
  const program = compile('print 1 + 1;');
  const { image, meta } = buildImage(program, { seed: 5 });
  // untampered runs fine
  let clean;
  try { clean = runJsImage(image, meta.salt); } catch (e) { clean = ['<throw> ' + e.message]; }
  ok('clean image runs', JSON.stringify(clean) === JSON.stringify(['2']), `got ${JSON.stringify(clean)}`);
  // flip one body byte (offset 10 is inside the checksummed body)
  const tampered = image.slice();
  tampered[10] = (tampered[10] ^ 0xff) & 0xff;
  let threw = false;
  try { runJsImage(tampered, meta.salt); } catch (_) { threw = true; }
  // the VM catches internally and prints to stderr; detect by absence of '2'
  let tamperedOut = [];
  try { tamperedOut = runJsImage(tampered, meta.salt); } catch (_) { threw = true; }
  ok('tampered image rejected', threw || JSON.stringify(tamperedOut) !== JSON.stringify(['2']),
    `got ${JSON.stringify(tamperedOut)}`);
}

console.log('== determinism / moving target ==');
{
  const a = generate('print 42;', { target: 'js', banner: false, seed: 1 }).output;
  const b = generate('print 42;', { target: 'js', banner: false, seed: 1 }).output;
  const c = generate('print 42;', { target: 'js', banner: false, seed: 2 }).output;
  ok('same seed -> identical build', a === b);
  ok('different seed -> different build', a !== c);
}

// The reference interpreter is async (real-promise async/await support), so the
// oracle / optimizer / import checks below MUST await it. They run inside an
// async IIFE that also emits the final report so ordering is preserved.
(async () => {
console.log('== reference interpreter as oracle (interp == VM) ==');
for (const c of cases) {
  let vm, ref;
  try { vm = runJs(c.src, 7); } catch (e) { vm = ['<throw> ' + e.message]; }
  try { ref = (await interpret(compile(c.src, { optimize: true }))).output; } catch (e) { ref = ['<throw> ' + e.message]; }
  ok('oracle ' + c.name, JSON.stringify(vm) === JSON.stringify(ref), `vm=${JSON.stringify(vm)} ref=${JSON.stringify(ref)}`);
}

console.log('== optimizer is behavior-preserving (opt == no-opt) ==');
for (const c of cases) {
  const off = (await interpret(compile(c.src, { optimize: false }))).output;
  const on = (await interpret(compile(c.src, { optimize: true }))).output;
  ok('optimize ' + c.name, JSON.stringify(off) === JSON.stringify(on), `off=${JSON.stringify(off)} on=${JSON.stringify(on)}`);
}

console.log('== resource limits (controlled failure) ==');
{
  const src = 'fn r(n){ if(n<=0){return 0;} return r(n-1); } print r(1000);';
  // no limit: runs fine
  let unbounded;
  try { unbounded = runJs(src, 3); } catch (e) { unbounded = ['<throw> ' + e.message]; }
  ok('deep recursion runs without limits', JSON.stringify(unbounded) === JSON.stringify(['0']), `got ${JSON.stringify(unbounded)}`);
  // with a small call-depth limit: rejected before completing
  const limited = generate(src, { target: 'js', banner: false, seed: 3, maxDepth: 50 }).output;
  let out = [], threw = false;
  try { out = captureStdout(() => {
    new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', limited)(
      { exports: {} }, {}, require, process, console, Buffer);
  }); } catch (_) { threw = true; }
  ok('call-depth limit trips', threw || JSON.stringify(out) !== JSON.stringify(['0']), `got ${JSON.stringify(out)}`);
}

console.log('== formalized header (format major/profile) ==');
{
  const { meta } = generate('print 1;', { target: 'js', seed: 1, profile: 'aggressive' });
  ok('header reports format major 2', meta.major === 2);
  ok('header records profile', meta.profile === 'aggressive');
  // a build for an unknown profile is rejected
  let threw = false;
  try { generate('print 1;', { target: 'js', profile: 'nope' }); } catch (_) { threw = true; }
  ok('unknown profile rejected', threw);
}

console.log('== modules / imports ==');
{
  const mods = {
    'math.vgs': 'fn dbl(n){ return n*2; }',
    'lib.vgs': 'import "math.vgs";\nfn quad(n){ return dbl(dbl(n)); }',
  };
  const resolveImport = (p) => (p in mods ? mods[p] : null);
  const src = 'import "lib.vgs";\nimport "math.vgs";\nprint quad(3); print dbl(5);';
  const out = (await interpret(compile(src, { resolveImport }))).output;
  ok('diamond import resolves once', JSON.stringify(out) === JSON.stringify(['12', '10']), `got ${JSON.stringify(out)}`);
  let threw = false;
  try { compile('import "math.vgs"; print 1;'); } catch (_) { threw = true; }
  ok('import without resolver is rejected', threw);
}

console.log('== constant concealment (aggressive profile) ==');
{
  // integers are stored as xor-expressions; output must be unchanged.
  const src = 'let x = 12345; let y = 678; print x + y; print 100 * 3;';
  const out = captureStdout(() => {
    const { output } = generate(src, { target: 'js', banner: false, seed: 3, profile: 'aggressive' });
    new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', output)(
      { exports: {} }, {}, require, process, console, Buffer);
  });
  ok('concealed integers still compute', JSON.stringify(out) === JSON.stringify(['13023', '300']), `got ${JSON.stringify(out)}`);
}

console.log('== signing / entitlement (keyed MAC) ==');
{
  const src = 'print 1 + 1;';
  const signed = generate(src, { target: 'js', banner: false, seed: 5, sign: 'secret-key' });
  ok('signed build sets the signed flag', signed.meta.signed === true);
  const runWithKey = (key) => {
    const prev = process.env.VMGEN_KEY;
    if (key === null) delete process.env.VMGEN_KEY; else process.env.VMGEN_KEY = key;
    let out = [];
    try { out = captureStdout(() => {
      new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', signed.output)(
        { exports: {} }, {}, require, process, console, Buffer);
    }); } catch (_) { /* controlled failure */ }
    if (prev === undefined) delete process.env.VMGEN_KEY; else process.env.VMGEN_KEY = prev;
    return out;
  };
  ok('runs with the correct key', JSON.stringify(runWithKey('secret-key')) === JSON.stringify(['2']));
  ok('blocked with a wrong key', JSON.stringify(runWithKey('wrong')) !== JSON.stringify(['2']));
  ok('blocked with no key', JSON.stringify(runWithKey(null)) !== JSON.stringify(['2']));
}

console.log('== multi-domain integrity (localized tamper) ==');
{
  const program = compile('let s = "secret"; fn g(){ return 42; } print s; print g();');
  const { image } = buildImage(program, { seed: 5, conceal: true });
  const runImg = (img) => {
    let out = [], threw = false;
    try { out = captureStdout(() => {
      new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', emitJs(img, { banner: false }))(
        { exports: {} }, {}, require, process, console, Buffer);
    }); } catch (_) { threw = true; }
    return { out, threw };
  };
  // tamper a byte inside the function region (near the end of the body)
  const t = image.slice();
  t[image.length - 4] = (t[image.length - 4] ^ 0xff) & 0xff;
  const r = runImg(t);
  ok('function-region tamper rejected', r.threw || JSON.stringify(r.out) !== JSON.stringify(['secret', '42']));
}

// ---- wired corpus: every source file under tests/ (in-repo) and, when present,
// the external modules/ directory must at least COMPILE + BUILD to a VM. Files
// that self-check (they print "Passed: N  Failed: M") are additionally run and
// must report zero failures. Missing dirs are skipped, so `npm test` stays green
// on machines without the external corpus.
console.log('== wired corpus (tests/ + modules/) ==');
{
  const SELF_CHECK = /Passed:\s*\d+/; // a file that prints its own pass/fail tally
  const listSources = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch (_) { return []; }
    return ents.filter((f) => /\.(js|vgs|mjs)$/.test(f) && !/\.vm\.js$/.test(f))
      .map((f) => path.join(dir, f));
  };
  const corpora = [
    { label: 'tests', dir: path.join(__dirname, '..', 'tests') },
    { label: 'modules', dir: path.join(__dirname, '..', 'modules') },
    { label: 'modules', dir: path.join(require('os').homedir(), 'OneDrive', 'Desktop', 'modules') },
    { label: 'modules', dir: 'C:/Users/eadan/OneDrive/Desktop/modules' },
  ];
  const seen = new Set();
  for (const { label, dir } of corpora) {
    const files = listSources(dir);
    for (const file of files) {
      const key = path.resolve(file); if (seen.has(key)) continue; seen.add(key);
      const name = label + '/' + path.basename(file);
      let source;
      try { source = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const baseDir = path.dirname(file);
      const resolveImport = (p) => { try { return fs.readFileSync(path.resolve(baseDir, p), 'utf8'); } catch (_) { return ''; } };
      // 1) must compile + build to a standalone VM
      let output = null;
      try { output = generate(source, { target: 'js', banner: false, seed: 1, resolveImport }).output; }
      catch (e) { ok('build ' + name, false, e.message.split('\n')[0]); continue; }
      ok('build ' + name, true);
      // 2) if it is a self-checking test, run it and require zero failures
      if (SELF_CHECK.test(source)) {
        let out = [];
        try {
          out = captureStdout(() => {
            new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', output)(
              { exports: {} }, {}, require, process, console, Buffer);
          });
        } catch (e) { ok('run ' + name, false, 'threw: ' + e.message.split('\n')[0]); continue; }
        const joined = out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
        const m = joined.match(/Failed:\s*(\d+)/);
        ok('run ' + name, !!m && m[1] === '0', m ? ('Failed: ' + m[1]) : 'no tally in output');
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
