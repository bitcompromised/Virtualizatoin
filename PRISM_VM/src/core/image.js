'use strict';
// Versioned binary image format + decoder. This is where Prism's upgradeability
// and its protection layers live:
//   * a self-describing header (magic, format major/minor, flags, cipher id,
//     integrity id) so a future decoder can recognize, dispatch on, and migrate
//     older images;
//   * an INTEGRITY DOMAIN -- a checksum (FNV-1a, or a seed-keyed MAC when signed)
//     over the header meta *and* the body, verified at load, so a tampered
//     artifact fails in a controlled way;
//   * a CONSTANT-POOL CIPHER -- the constant blob is transformed by a selected
//     cipher (XOR keystream by default), so literals are not stored in the clear.
//
// The cipher and integrity are `kind:'cipher'`/`kind:'integrity'` plugins resolved
// at encode time (src/core/protect.js) and dispatched at decode time by the small
// id bytes in the header. Built-in ids (< 16) are inlined into `decodeImage` so the
// standalone VM stays self-contained; a third-party algorithm (id >= 16) is passed
// to `decodeImage` via `ext` (the emitter embeds its pure decode/digest verbatim).
//
//   header (19 bytes):
//     0     'P' (0x50)
//     1     'R' (0x52)
//     2     format major
//     3     format minor
//     4     flags        (bit0: const blob enciphered, bit1: opcodes permuted, bit2: signed)
//     5     cipher id
//     6     integrity id
//     7..10  u32 key seed  (LE)   -- cipher keystream + permutation seed
//     11..14 u32 sign key  (LE)   -- MAC key when signed, else 0
//     15..18 u32 digest    (LE)   -- integrity checksum / MAC over meta+body
//   body:  u16 nconsts | u32 constLen | constBlob | u16 nfns | fn*

const FORMAT_MAJOR = 1;
const FORMAT_MINOR = 1; // 1.1: self-describing cipher/integrity ids + sign key
const BODY = 19;
const { opWidth, OPS } = require('./spec'); // encode-time only (decodeImage stays standalone)
const { resolveCipher, resolveIntegrity } = require('./protect');

// A seeded permutation of [0, n) via Fisher-Yates. Identical here and in the VM
// (embedded verbatim), so the VM regenerates the same opcode map from the seed.
function derivePerm(seed, n) {
  const perm = []; for (let i = 0; i < n; i++) perm[i] = i;
  let s = ((seed ^ 0x1a2b3c4d) >>> 0);
  for (let i = n - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  return perm;
}

// ---- encoder (build time; may use Node conveniences) ----
function encodeImage(image, opts = {}) {
  const keySeed = ((opts.seed !== undefined ? opts.seed : 0x2545f491) >>> 0);
  const cipher = resolveCipher(opts);
  const integ = resolveIntegrity(opts);
  const signKey = (integ.signed ? ((opts.signKey !== undefined ? opts.signKey : 0x7a1cf00d) >>> 0) : 0) >>> 0;

  // constant blob
  const cb = [];
  const dv = new DataView(new ArrayBuffer(8));
  for (const c of image.consts) {
    if (typeof c === 'number') { cb.push(0); dv.setFloat64(0, c, true); for (let b = 0; b < 8; b++) cb.push(dv.getUint8(b)); }
    else if (typeof c === 'string') { const u = Buffer.from(c, 'utf8'); cb.push(1, u.length & 0xff, (u.length >>> 8) & 0xff); for (const x of u) cb.push(x); }
    else if (c === true) cb.push(2);
    else if (c === false) cb.push(3);
    else cb.push(4);
  }
  cipher.encode(cb, keySeed); // selected constant-pool cipher (no-op for 'none')

  // opcode permutation: remap opcode bytes (operands untouched) so the stored
  // dispatch bytes differ every build; the VM regenerates the map from the seed.
  const permute = opts.permute === true;
  const perm = permute ? derivePerm(keySeed, OPS.length) : null;

  // function blob
  const fb = [];
  for (const fn of image.functions) {
    fb.push(fn.nparams & 0xff, fn.nlocals & 0xff, (fn.nlocals >>> 8) & 0xff, fn.code.length & 0xff, (fn.code.length >>> 8) & 0xff);
    if (permute) {
      let p = 0;
      while (p < fn.code.length) { const canon = fn.code[p]; const w = opWidth(canon); fb.push(perm[canon] & 0xff); for (let q = 1; q < w; q++) fb.push(fn.code[p + q] & 0xff); p += w; }
    } else {
      for (const x of fn.code) fb.push(x & 0xff);
    }
    const ups = fn.upvals || [];
    fb.push(ups.length & 0xff);
    for (const u of ups) fb.push(u.fromLocal ? 1 : 0, u.index & 0xff, (u.index >>> 8) & 0xff);
  }

  // body = nconsts | constLen | constBlob | nfns | fns
  const body = [];
  body.push(image.consts.length & 0xff, (image.consts.length >>> 8) & 0xff);
  body.push(cb.length & 0xff, (cb.length >>> 8) & 0xff, (cb.length >>> 16) & 0xff, (cb.length >>> 24) & 0xff);
  for (const x of cb) body.push(x);
  body.push(image.functions.length & 0xff, (image.functions.length >>> 8) & 0xff);
  for (const x of fb) body.push(x);

  let flags = 0;
  if (cipher.id !== 0) flags |= 1;
  if (permute) flags |= 2;
  if (integ.signed) flags |= 4;

  // header meta = bytes [2..14]: major, minor, flags, cipherId, integId, seed, signKey
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const meta = [FORMAT_MAJOR, FORMAT_MINOR, flags, cipher.id & 0xff, integ.id & 0xff].concat(u32(keySeed), u32(signKey));

  // integrity domain: the digest covers meta AND body (so tampering the key,
  // flags, cipher/integrity ids, or body is all caught).
  const digest = integ.digest(meta.concat(body), signKey) >>> 0;

  const out = [0x50, 0x52].concat(meta, u32(digest));
  for (const x of body) out.push(x);
  return out;
}

// ---- decoder (also embedded verbatim in the standalone VM) ----
// `ext` (optional) supplies third-party algorithms by id: { ciphers:{id:decode},
// integrities:{id:digest} }. Built-in ids (< 16) are handled inline, so the common
// artifact needs no ext at all.
function decodeImage(bytes, ext) {
  ext = ext || {};
  var BODY = 19; // header length; kept local so the decoder embeds self-contained
  function u16(o) { return bytes[o] | (bytes[o + 1] << 8); }
  function u32(o) { return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0; }
  function fnv(arr, key) {
    var h = 0x811c9dc5 >>> 0;
    if (key) { for (var b = 0; b < 4; b++) { h = (h ^ ((key >>> (b * 8)) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } }
    for (var i = 0; i < arr.length; i++) { h = (h ^ arr[i]) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x52) throw new Error('bad magic');
  var major = bytes[2];
  if (major !== 1) throw new Error('unsupported image format ' + major); // migration seam: dispatch here
  var minor = bytes[3];
  if (minor > 1) throw new Error('image format 1.' + minor + ' is newer than this decoder');
  var flags = bytes[4];
  var cipherId = bytes[5];
  var integId = bytes[6];
  var keySeed = u32(7);
  var signKey = u32(11);
  var checksum = u32(15);

  // integrity domain = header meta (bytes 2..14) + body (bytes 19..end)
  var dom = [];
  for (var mi = 2; mi <= 14; mi++) dom.push(bytes[mi]);
  for (var bi = BODY; bi < bytes.length; bi++) dom.push(bytes[bi]);
  var digest;
  if (integId === 1) digest = fnv(dom, 0);
  else if (integId === 2) digest = fnv(dom, signKey);
  else if (ext.integrities && ext.integrities[integId]) digest = ext.integrities[integId](dom, signKey) >>> 0;
  else throw new Error('unsupported integrity algorithm ' + integId);
  if (digest !== checksum) throw new Error('integrity check failed: image tampered');

  var p = BODY;
  var nconsts = u16(p); p += 2;
  var constLen = u32(p); p += 4;
  var cb = bytes.slice(p, p + constLen); p += constLen;
  if (cipherId === 1) {
    var s = (keySeed ^ 0x9e3779b9) >>> 0;
    for (var j = 0; j < cb.length; j++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; cb[j] = (cb[j] ^ (s >>> 24)) & 0xff; }
  } else if (cipherId !== 0) {
    if (ext.ciphers && ext.ciphers[cipherId]) ext.ciphers[cipherId](cb, keySeed);
    else throw new Error('unsupported cipher ' + cipherId);
  }
  var consts = [];
  var cp = 0;
  var dv = new DataView(new ArrayBuffer(8));
  while (consts.length < nconsts) {
    var tag = cb[cp++];
    if (tag === 0) { for (var b2 = 0; b2 < 8; b2++) dv.setUint8(b2, cb[cp++]); consts.push(dv.getFloat64(0, true)); }
    else if (tag === 1) { var ln = cb[cp] | (cb[cp + 1] << 8); cp += 2; var raw = ''; for (var k = 0; k < ln; k++) raw += String.fromCharCode(cb[cp++]); consts.push(decodeURIComponent(escape(raw))); }
    else if (tag === 2) consts.push(true);
    else if (tag === 3) consts.push(false);
    else consts.push(null);
  }
  var nfns = u16(p); p += 2;
  var functions = [];
  for (var f = 0; f < nfns; f++) {
    var nparams = bytes[p++];
    var nlocals = u16(p); p += 2;
    var codeLen = u16(p); p += 2;
    var code = [];
    for (var c = 0; c < codeLen; c++) code.push(bytes[p++]);
    var nup = bytes[p++];
    var upvals = [];
    for (var u = 0; u < nup; u++) { var fl = bytes[p++]; var idx = u16(p); p += 2; upvals.push({ fromLocal: fl === 1, index: idx }); }
    functions.push({ nparams: nparams, nlocals: nlocals, code: code, upvals: upvals });
  }
  return { consts: consts, functions: functions, entry: 0, flags: flags, keySeed: keySeed };
}

// Emit-time helper: a JS source fragment for the `ext` argument to decodeImage,
// embedding any THIRD-PARTY cipher/integrity used by this build (built-ins need
// none). Returns '' when only built-ins are in play.
function decodeExtSource(opts = {}) {
  const cipher = resolveCipher(opts);
  const integ = resolveIntegrity(opts);
  const ciphers = [];
  const integrities = [];
  if (cipher.id >= 16) {
    if (typeof cipher.decode !== 'function') throw new Error(`cipher '${cipher.name}' needs a decode()`);
    ciphers.push(cipher.id + ': ' + asFnExpr(cipher.decode));
  }
  if (integ.id >= 16) {
    if (typeof integ.digest !== 'function') throw new Error(`integrity '${integ.name}' needs a digest()`);
    integrities.push(integ.id + ': ' + asFnExpr(integ.digest));
  }
  if (!ciphers.length && !integrities.length) return '';
  return ', { ciphers: { ' + ciphers.join(', ') + ' }, integrities: { ' + integrities.join(', ') + ' } }';
}
// Render a function's source as a valid expression to embed. Method-shorthand
// (`decode(a,b){...}`) is not an expression on its own, so give it the `function`
// keyword; arrows and `function`-forms are already expressions.
function asFnExpr(fn) {
  const src = fn.toString().trim();
  if (/^(function\b|async\b|\()/.test(src)) return src;
  return 'function ' + src;
}

module.exports = { encodeImage, decodeImage, derivePerm, decodeExtSource, FORMAT_MAJOR, FORMAT_MINOR };
