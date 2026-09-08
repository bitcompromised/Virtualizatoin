'use strict';
// Inline protection pragmas. A program can request its own protection directly in
// source with `<@protect ...>` -- so a build is reproducible from the file alone,
// no CLI flags or API options required. Explicit build options always WIN over an
// inline pragma (the caller can override the file), so this is a default-setting
// layer, not a lock.
//
//   <@protect encrypt permute sign decoys=3 strength=2 bogus=1 backend=py>
//
// Recognized tokens (bare flag, or key=value):
//   encrypt | no-encrypt      -> encryptConsts            (const-pool cipher)
//   permute                   -> permute                  (opcode permutation)
//   sign                      -> protect.sign             (keyed integrity/MAC)
//   integrity=fnv1a|fnv1a-mac -> protect.integrity        (integrity algorithm)
//   cipher=none|xor           -> protect.cipher           (const-pool cipher algo)
//   encrypted                 -> encrypted                (encrypted register SP)
//   decoys=N                  -> protect.decoys
//   strength=N                -> protect.decoyStrength
//   bogus=N                   -> protect.bogus
//   optimize | no-optimize    -> optimize
//   seed=N                    -> seed
//   backend=js|lua|py         -> target
//   machine=stack|register    -> machine
//
// The pragma is stripped from the source before parsing; unknown tokens throw so a
// typo fails loudly instead of silently doing nothing.

const FLAG = {
  encrypt: ['encryptConsts', true],
  'no-encrypt': ['encryptConsts', false],
  permute: ['permute', true],
  encrypted: ['encrypted', true],
  optimize: ['optimize', true],
  'no-optimize': ['optimize', false],
  sign: ['@protect.sign', true],
};
const KV = {
  decoys: (v, o) => setP(o, 'decoys', int(v)),
  strength: (v, o) => setP(o, 'decoyStrength', int(v)),
  bogus: (v, o) => setP(o, 'bogus', int(v)),
  sign: (v, o) => setP(o, 'sign', v !== 'false'),
  integrity: (v, o) => setP(o, 'integrity', v),
  cipher: (v, o) => setP(o, 'cipher', v),
  seed: (v, o) => { o.seed = int(v); },
  optimize: (v, o) => { o.optimize = v !== 'false'; },
  backend: (v, o) => { o.target = v.toLowerCase(); },
  target: (v, o) => { o.target = v.toLowerCase(); },
  machine: (v, o) => { o.machine = v.toLowerCase(); },
};
function int(v) { const n = parseInt(v, 10); if (!Number.isFinite(n)) throw new Error(`prism: <@protect> expected a number, got '${v}'`); return n; }
function setP(o, k, v) { (o.protect = o.protect || {})[k] = v; }

// Parse and strip every `<@protect ...>` in `source`. Returns { source, opts }.
function parsePragmas(source) {
  const opts = {};
  let out = '';
  let i = 0;
  const RE = /<@protect\b([^>]*)>/g;
  let m, last = 0;
  while ((m = RE.exec(source)) !== null) {
    out += source.slice(last, m.index);
    last = m.index + m[0].length;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const eq = tok.indexOf('=');
      if (eq === -1) {
        const f = FLAG[tok.toLowerCase()];
        if (!f) throw new Error(`prism: unknown <@protect> flag '${tok}'`);
        if (f[0] === '@protect.sign') setP(opts, 'sign', f[1]); else opts[f[0]] = f[1];
      } else {
        const key = tok.slice(0, eq).toLowerCase();
        const val = tok.slice(eq + 1);
        const fn = KV[key];
        if (!fn) throw new Error(`prism: unknown <@protect> option '${key}'`);
        fn(val, opts);
      }
    }
  }
  out += source.slice(last);
  return { source: out, opts };
}

// Merge inline (base) under explicit (wins). `protect` and `plugins` merge, not clobber.
function mergeOpts(inline, explicit) {
  const out = Object.assign({}, inline, explicit);
  if (inline.protect || explicit.protect) out.protect = Object.assign({}, inline.protect, explicit.protect);
  return out;
}

module.exports = { parsePragmas, mergeOpts };
