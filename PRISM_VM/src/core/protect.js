'use strict';
// Protection algorithm registry -- the `cipher` and `integrity` extension points,
// consumed. Each is a plugin descriptor selected at encode time and dispatched at
// decode time by a small id stored in the image header:
//
//   cipher    { kind:'cipher',    name, id, encode(blob, seed), decode(blob, seed) }
//   integrity { kind:'integrity', name, id, signed, digest(bytes, signKey) -> u32 }
//
// Built-in ids are < 16 and are inlined into the embedded decoder (so the standalone
// artifact stays self-contained). A third-party plugin takes an id >= 16; its
// `decode`/`digest` are pure and get embedded verbatim (via Function.prototype
// .toString) into the JS artifact, exactly like the machine and decoder. `encode`/
// `decode` mutate the constant-blob byte array in place; `digest` is a pure hash of
// the integrity domain (header meta + body). Honest-obfuscation caveat holds: the
// seed and any sign key ship inside the artifact -- this raises analysis cost, it
// is not cryptography.

const { definePlugin } = require('./plugin');

// ---- built-in ciphers ----
const CIPHER_NONE = definePlugin({ kind: 'cipher', name: 'none', id: 0, encode() {}, decode() {} });
function xorStream(blob, seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  for (let j = 0; j < blob.length; j++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; blob[j] = (blob[j] ^ (s >>> 24)) & 0xff; }
}
const CIPHER_XOR = definePlugin({ kind: 'cipher', name: 'xor', id: 1, encode: xorStream, decode: xorStream });
const BUILTIN_CIPHERS = [CIPHER_NONE, CIPHER_XOR];

// ---- built-in integrities ----
// FNV-1a over the domain; the MAC variant folds the sign key into the basis first,
// so a tampered artifact must also know the (embedded) key to forge a match.
function fnv1a(bytes, key) {
  let h = 0x811c9dc5 >>> 0;
  if (key) { for (let b = 0; b < 4; b++) { h = (h ^ ((key >>> (b * 8)) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } }
  for (let i = 0; i < bytes.length; i++) { h = (h ^ bytes[i]) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const INTEG_FNV = definePlugin({ kind: 'integrity', name: 'fnv1a', id: 1, signed: false, digest: (bytes) => fnv1a(bytes, 0) });
const INTEG_MAC = definePlugin({ kind: 'integrity', name: 'fnv1a-mac', id: 2, signed: true, digest: (bytes, signKey) => fnv1a(bytes, signKey >>> 0) });
const BUILTIN_INTEGRITIES = [INTEG_FNV, INTEG_MAC];

function resolveCipher(opts = {}) {
  const custom = (opts.plugins || []).filter((p) => p && p.kind === 'cipher');
  const name = opts.protect && opts.protect.cipher;
  if (name) {
    const c = custom.find((p) => p.name === name) || BUILTIN_CIPHERS.find((p) => p.name === name);
    if (!c) throw new Error(`Prism: unknown cipher '${name}'`);
    return c;
  }
  return opts.encryptConsts === false ? CIPHER_NONE : CIPHER_XOR;
}
function resolveIntegrity(opts = {}) {
  const custom = (opts.plugins || []).filter((p) => p && p.kind === 'integrity');
  const name = (opts.protect && opts.protect.integrity) || (opts.protect && opts.protect.sign ? 'fnv1a-mac' : null);
  if (name) {
    const it = custom.find((p) => p.name === name) || BUILTIN_INTEGRITIES.find((p) => p.name === name);
    if (!it) throw new Error(`Prism: unknown integrity '${name}'`);
    return it;
  }
  return INTEG_FNV;
}

module.exports = { resolveCipher, resolveIntegrity, BUILTIN_CIPHERS, BUILTIN_INTEGRITIES, fnv1a, xorStream };
