'use strict';
// The Prism programmatic API -- the one stable surface. The CLI and (later) the
// web UI are thin clients over these functions. Results are structured objects,
// never scraped console output.

const { compile } = require('./core/compiler');
const { interpret } = require('./backends/interp');
const { resolveBackend } = require('./backends/registry');
const { resolveCipher, resolveIntegrity } = require('./core/protect');
const { encodeImage, FORMAT_MAJOR, FORMAT_MINOR } = require('./core/image');
const { parse } = require('./frontend/parser');
const V = require('./core/version');

// source -> canonical image (no protection layers yet; that is Phase 4).
function toImage(source, opts = {}) { return compile(source, opts); }

// source -> executed on the reference interpreter (the oracle).
function run(source, opts = {}) { const image = compile(source, opts); return interpret(image, image.opts); }

// source -> a standalone protected(-ish) artifact for a target. Options come from
// the resolved image (inline `<@protect>` merged under explicit opts).
function build(source, opts = {}) {
  const image = compile(source, opts);
  const eff = image.opts || opts;
  let target = (eff.target || 'js').toLowerCase();
  if (target === 'python') target = 'py';
  const machine = (eff.machine || 'stack').toLowerCase();
  const singleModel = target === 'lua' || target === 'py'; // targets without a register model
  const be = resolveBackend(target, machine, eff);
  const code = be.emit(image, eff);
  const imageBytes = target === 'js' ? encodeImage(image, eff).length : 0;
  const cipher = resolveCipher(eff);
  const integ = resolveIntegrity(eff);
  const meta = {
    target,
    machine: singleModel ? 'stack' : machine,
    backend: be.name,
    prism: V.PRISM_VERSION,
    imageFormat: `${FORMAT_MAJOR}.${FORMAT_MINOR}`,
    numFns: image.functions.length,
    numConsts: image.consts.length,
    codeBytes: image.functions.reduce((a, f) => a + f.code.length, 0),
    imageBytes,
    decoys: (eff.protect && eff.protect.decoys) || 0,
    cipher: cipher.name,
    integrity: integ.name,
    protected: {
      integrity: true,
      signed: integ.signed && target === 'js',
      constCipher: cipher.id !== 0 && target === 'js',
      permuted: !!eff.permute && target === 'js',
      encryptedState: !!eff.encrypted,
    },
  };
  return { code, image, meta };
}

// source -> per-function scope report (functions, params, locals) for tooling.
function analyze(source) {
  const ast = parse(source);
  const fns = [{ name: '(top-level)', params: [], locals: collectLets(ast.body), isMain: true }];
  for (const s of ast.body) {
    if (s.type === 'FnDecl') fns.push({ name: s.name, params: s.params.slice(), locals: collectLets(s.body.body || []), isMain: false });
  }
  return { functions: fns };
}
function collectLets(body) {
  const out = [];
  for (const s of body || []) if (s.type === 'Let' && s.name) out.push(s.name);
  return out;
}

module.exports = { toImage, run, build, analyze, version: V.PRISM_VERSION };
