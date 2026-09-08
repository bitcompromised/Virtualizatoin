'use strict';
// Plugin SDK gate: a third party extends Prism -- a pass, a language directive,
// and even a new OPCODE -- WITHOUT touching core, and each extension is verified
// against the multi-backend oracle by the SDK's own `testPlugin` harness.

const { definePlugin, registerOpcode, testPlugin } = require('../src/sdk');
const { OP } = require('../src/core/spec');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
}

console.log('== SDK: third-party extensions ==');

// 1. a custom PASS (net-zero DUP;POP churn after every LOAD)
const churn = definePlugin({
  kind: 'pass', name: 'dup-pop', stage: 'obfuscate',
  run(fn) { const out = []; for (const ins of fn.instrs) { out.push(ins); if (ins.op === OP.LOAD) { out.push({ op: OP.DUP, args: [] }); out.push({ op: OP.POP, args: [] }); } } fn.instrs = out; },
});
let r = testPlugin(churn, [{ name: 'custom pass preserves semantics', src: 'function f(n){ return n + n; } print f(21);', expect: ['42'] }]);
ok(r.results[0].name, r.failed === 0, JSON.stringify(r.results[0].backends));

// 2. a custom DIRECTIVE (a language macro: unroll a block N times)
const repeat = definePlugin({
  kind: 'directive', name: 'repeat',
  expand(args, block) { const n = parseInt(args[0], 10) || 0; let s = ''; for (let i = 0; i < n; i++) s += (block || '') + '\n'; return s; },
});
r = testPlugin(repeat, [{ name: 'directive unrolls a block', src: 'let s = 0; <@repeat 3> { s = s + 10; } print s;', expect: ['30'] }]);
ok(r.results[0].name, r.failed === 0, JSON.stringify(r.results[0].backends));

// 3. a new OPCODE (extend the ISA) + a fusion pass that uses it. Every backend
//    regenerates its handler from `sem`, so the oracle stays in lock-step.
registerOpcode({ name: 'INC', operands: [], sem: [['let', 'a', ['pop']], ['push', ['bin', '+', ['var', 'a'], ['lit', 1]]]] });
const incFusion = definePlugin({
  kind: 'pass', name: 'inc-fusion', stage: 'optimize',
  run(fn, ctx) {
    const out = [];
    for (let i = 0; i < fn.instrs.length; i++) {
      const a = fn.instrs[i], b = fn.instrs[i + 1];
      if (a && a.op === ctx.OP.PUSH_CONST && ctx.consts[a.args[0]] === 1 && b && b.op === ctx.OP.ADD) { out.push({ op: ctx.OP.INC, args: [] }); i++; }
      else out.push(a);
    }
    fn.instrs = out;
  },
});
r = testPlugin(incFusion, [
  { name: 'new opcode fuses x + 1', src: 'function f(n){ return n + 1; } print f(41);', expect: ['42'] },
  { name: 'new opcode in a loop', src: 'let i = 0; while (i < 5) { i = i + 1; } print i;', expect: ['5'] },
]);
ok(r.results[0].name, r.results[0].ok, JSON.stringify(r.results[0].backends));
ok(r.results[1].name, r.results[1].ok, JSON.stringify(r.results[1].backends));

// prove the fusion actually emitted the new opcode (not a no-op)
{
  const { compile } = require('../src/core/compiler');
  const img = compile('function f(n){ return n + 1; } print f(41);', { plugins: [incFusion] });
  ok('INC opcode is actually emitted by the pass', img.functions.some((fn) => fn.code.includes(OP.INC)));
}

// 4. a custom DECOY (kind:'decoy'): a third party supplies decoy bodies. The
//    compiler appends them (unreferenced), so behavior is unchanged on every
//    backend -- and the decoy is really present in the image.
const myDecoy = definePlugin({
  kind: 'decoy', name: 'my-decoy',
  generate(fn, ctx) {
    const a = fn.slot('a', true);
    fn.emit(ctx.OP.PUSH_CONST, ctx.constId(1234567)); fn.emit(ctx.OP.STORE, a);
    fn.emit(ctx.OP.LOAD, a); fn.emit(ctx.OP.LOAD, a); fn.emit(ctx.OP.ADD); fn.emit(ctx.OP.RET);
  },
});
r = testPlugin(myDecoy, [{ name: 'custom decoy preserves semantics', src: 'function f(n){ return n * n; } print f(9);', expect: ['81'] }], { protect: { decoys: 2 } });
ok(r.results[0].name, r.results[0].ok, JSON.stringify(r.results[0].backends));
{
  const { compile } = require('../src/core/compiler');
  const bare = compile('function f(n){ return n * n; } print f(9);');
  const withDecoy = compile('function f(n){ return n * n; } print f(9);', { plugins: [myDecoy], protect: { decoys: 2 } });
  ok('custom decoy is actually appended', withDecoy.functions.length === bare.functions.length + 2 && withDecoy.consts.includes(1234567));
}

// 5. custom CIPHER + INTEGRITY (kind:'cipher' / kind:'integrity'): a third party
//    swaps the constant-pool cipher and the image checksum. testPlugin builds the
//    standalone artifact with them (decode/digest embedded) and checks it agrees.
const rotCipher = definePlugin({
  kind: 'cipher', name: 'rot13x', id: 30,
  encode(blob, seed) { const k = (seed % 200) + 1; for (let i = 0; i < blob.length; i++) blob[i] = (blob[i] + k) & 0xff; },
  decode(blob, seed) { const k = (seed % 200) + 1; for (let i = 0; i < blob.length; i++) blob[i] = (blob[i] - k) & 0xff; },
});
const sumIntegrity = definePlugin({
  kind: 'integrity', name: 'sum32', id: 31, signed: false,
  digest(bytes) { let h = 2166136261 >>> 0; for (let i = 0; i < bytes.length; i++) { h = (Math.imul(h, 16777619) ^ bytes[i]) >>> 0; } return h >>> 0; },
});
r = testPlugin([rotCipher, sumIntegrity],
  [{ name: 'custom cipher+integrity preserves semantics', src: 'print "SECRET" + " " + (6 * 7);', expect: ['SECRET 42'] }],
  { protect: { cipher: 'rot13x', integrity: 'sum32' } });
ok(r.results[0].name, r.results[0].ok, JSON.stringify(r.results[0].backends));

// 6. custom BACKEND (kind:'backend'): a third party adds a target. Here a trivial
//    "commented JS" backend wrapping the built-in emitter; api.build resolves it
//    from the registry by `target` and the artifact runs.
{
  const api = require('../src/api');
  const { emitJs } = require('../src/backends/emit-js');
  const tagBackend = definePlugin({
    kind: 'backend', name: 'js-tagged', target: 'js-tagged',
    emit(image, opts) { return '/* prism: third-party backend */\n' + emitJs(image, opts); },
  });
  const { code, meta } = api.build('print 3 + 4;', { target: 'js-tagged', plugins: [tagBackend] });
  const out = [];
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { new Function('process', code)(process); } finally { process.stdout.write = w; } // eslint-disable-line no-new-func
  ok('custom backend resolved & runs', meta.backend === 'js-tagged' && code.indexOf('third-party backend') !== -1 && JSON.stringify(out.join('').split('\n').filter((x) => x.length)) === JSON.stringify(['7']));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
