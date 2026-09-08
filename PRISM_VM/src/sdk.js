'use strict';
// @prism/plugin-sdk -- the public, stable surface for extending Prism without
// touching core. The built-in passes/opcodes/directives use exactly this API.
//
// Extension points (a plugin is `{ kind, name, ... }`):
//   kind:'pass'      { stage:'optimize'|'obfuscate'|'lower', run(fn, ctx) }
//                    fn.instrs is the function IR (label-marker jump targets);
//                    ctx = { rng, constId, consts, OP, OPS, opWidth }.
//                    Pass to build/run via `plugins:[...]`.
//   kind:'directive' { name, expand(args, block) -> sourceString }
//                    Expands `<@name ...> { block }` before parsing.
//   kind:'opcode'    { name, operands, sem }  -> registerOpcode(...) extends the
//                    ISA; every backend regenerates its handler from `sem`.
//   kind:'decoy'     { name, generate(fn, ctx) } -- emits an unreferenced function
//                    into the image (fn = a compiler FnScope; ctx = { rng, constId,
//                    OP }). Enabled by `protect:{ decoys:N }`; output-neutral by
//                    construction, proven on every backend by the oracle.
//   kind:'cipher'    { name, id>=16, encode(blob,seed), decode(blob,seed) } -- the
//                    constant-pool cipher; selected via `protect:{ cipher:name }`.
//                    `decode` is pure and embedded into the JS artifact verbatim.
//   kind:'integrity' { name, id>=16, signed?, digest(bytes,signKey)->u32 } -- the
//                    image checksum/MAC; selected via `protect:{ integrity:name }`
//                    (or `protect:{ sign:true }` for the built-in keyed MAC).
//   kind:'backend'   { name, target, machine?, emit(image,opts)->code } -- a codegen
//                    target; selected via `target:name` (or `<@protect backend=name>`).
//
// `testPlugin` lets a plugin author verify their plugin against the multi-backend
// oracle (interpreter ≡ every emitted VM ≡ expected) -- the same gate core uses.

const { definePlugin, createRegistry } = require('./core/plugin');
const { registerOpcode } = require('./core/spec');
const { expandDirectives } = require('./core/directives');

// Run a set of {src, expect} cases through a build that includes `plugins`, on
// every available backend, and check they all agree. Returns a structured report.
function testPlugin(plugins, cases, opts = {}) {
  const { compile } = require('./core/compiler');
  const { interpret } = require('./backends/interp');
  const { emitJs } = require('./backends/emit-js');
  const { interpretReg } = require('./backends/emit-js-reg');
  const buildOpts = Object.assign({ plugins: [].concat(plugins) }, opts);

  const runEmitted = (code) => {
    const lines = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { lines.push(String(s)); return true; };
    try { new Function('process', code)(process); } finally { process.stdout.write = w; } // eslint-disable-line no-new-func
    return lines.join('').split('\n').filter((x) => x.length);
  };

  const results = [];
  let passed = 0, failed = 0;
  for (const c of cases) {
    const img = compile(c.src, buildOpts);
    const emitOpts = Object.assign({ banner: false }, buildOpts);
    const backends = {
      interp: safe(() => interpret(img).output),
      register: safe(() => interpretReg(img).output),
      emitJs: safe(() => runEmitted(emitJs(img, emitOpts))),
    };
    const exp = JSON.stringify(c.expect);
    const agree = Object.values(backends).every((o) => JSON.stringify(o) === exp);
    results.push({ name: c.name || c.src, ok: agree, backends });
    if (agree) passed++; else failed++;
  }
  return { passed, failed, results };
}
function safe(fn) { try { return fn(); } catch (e) { return ['<throw> ' + e.message]; } }

const { resolveBackend } = require('./backends/registry');
module.exports = { definePlugin, createRegistry, registerOpcode, expandDirectives, testPlugin, resolveBackend };
