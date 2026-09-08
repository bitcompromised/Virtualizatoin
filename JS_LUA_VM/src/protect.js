'use strict';
// Protection layer: turns a canonical compiled program into a single opaque
// "image" byte array with several code-protection techniques applied.
//
//   1. Opcode permutation  - every build maps canonical opcodes to random bytes.
//   2. Bytecode encryption - each function's byte stream is XORed with a keyed
//                            LCG keystream (unique per function).
//   3. Constant encryption - the constant pool is serialized and encrypted.
//   4. Integrity checksum  - an FNV-1a checksum over the image body detects any
//                            tampering; the generated VM refuses to run if it
//                            does not match.
//
// Every primitive here is duplicated *verbatim in behavior* inside the emitted
// JS and Lua VMs (see emit-js.js / emit-lua.js). The unit tests round-trip
// through both to guarantee they stay in lock-step.

const { OP, OP_NAME, OP_OPERANDS } = require('./opcodes');
const V = require('./version');

// Plausible-looking names for decoy ("dud") functions. They are never called;
// their only purpose is to give a static analyst extra believable code to read.
const DUD_NAMES = [
  'validateLicense', 'deriveSessionKey', 'checkEntitlement', 'unpackResource',
  'rotateKeystream', 'verifyManifest', 'decodeTelemetry', 'resolveBinding',
  'scrubHeap', 'auditTable', 'reseedEntropy', 'flushDispatch', 'auth', 'authenticate', 'load',
];

const MASK32 = 0x100000000; // 2^32

// ---- 32-bit primitives (must be bit-exact in JS and Lua) ----
function mul32(a, b) {
  a = a % MASK32; b = b % MASK32;
  const ah = Math.floor(a / 65536), al = a % 65536;
  const r = ((ah * b) % 65536) * 65536 + al * b;
  return r % MASK32;
}
function lcgNext(state) {
  // state = state*1664525 + 1013904223  (mod 2^32)
  return (mul32(state, 1664525) + 1013904223) % MASK32;
}
function keystreamByte(state) {
  // high byte of state
  return Math.floor(state / 16777216) % 256;
}
function fnSeed(codeSeed, fnIdx) {
  return (codeSeed + mul32(fnIdx, 2654435761)) % MASK32;
}
// Per-round key for a function's bytecode. Round 0 is exactly fnSeed so a single
// round matches the historical single-pass cipher; further rounds use distinct
// keystreams. XOR is self-inverse, so encrypting and decrypting are the same op.
function roundSeed(codeSeed, fnIdx, r) {
  return r === 0 ? fnSeed(codeSeed, fnIdx) : (fnSeed(codeSeed, fnIdx) + mul32(r, 2246822519)) % MASK32;
}
function encRounds(bytes, codeSeed, fnIdx, rounds) {
  let out = bytes;
  for (let r = 0; r < rounds; r++) out = cipher(out, roundSeed(codeSeed, fnIdx, r));
  return out;
}

// XOR-encrypt/decrypt a byte array in place-style (returns new array).
function cipher(bytes, seed) {
  let st = seed % MASK32;
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    st = lcgNext(st);
    out[i] = (bytes[i] ^ keystreamByte(st)) & 0xff;
  }
  return out;
}

// Keyed 64-bit MAC over a byte array (obfuscation-grade authenticity, not a
// cryptographic primitive): two FNV-1a passes with the key mixed in on both
// sides. Returned as 8 bytes. The generated VMs compute this identically.
function keyedMac(keyBytes, bytes) {
  const m1 = fnv1a(keyBytes.concat(bytes));
  const m2 = fnv1a(bytes.concat(keyBytes).concat([0x9e, 0x37, 0x79, 0xb9]));
  const out = [];
  w32(out, m1); w32(out, m2);
  return out;
}

// FNV-1a 32-bit over a byte array.
function fnv1a(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    // xor with a byte only touches the low 8 bits
    const low = h % 256;
    h = h - low + (low ^ bytes[i]);
    h = mul32(h, 16777619);
  }
  return h % MASK32;
}

// ---- small deterministic RNG for reproducible builds ----
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s = lcgNext(s); return s; };
}

// ---- byte writers ----
function w8(arr, v) { arr.push(v & 0xff); }
function w16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
function w32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

// ---- encode one function's instructions to canonical bytes using perm ----
function encodeFunction(fn, perm) {
  const bytes = [];
  for (const ins of fn.instrs) {
    bytes.push(perm[ins.op]);
    const kinds = OP_OPERANDS[ins.op];
    for (let k = 0; k < kinds.length; k++) {
      const v = ins.args[k];
      if (kinds[k] === 'u16') { bytes.push(v & 0xff, (v >>> 8) & 0xff); }
      else { bytes.push(v & 0xff); }
    }
  }
  return bytes;
}

// ---- serialize the constant pool to a plain byte blob ----
// tag 0 = number (decimal text), tag 1 = string (utf-8),
// tag 2 = concealed non-negative integer stored as an *unsolved expression*
//         A xor B where A is random -- the VM must compute A^B to recover it, so
//         the literal value never appears even after the pool cipher is broken.
function serializeConsts(consts, conceal, rng) {
  const blob = [];
  for (const c of consts) {
    if (conceal && typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < 0x80000000 && !Object.is(c, -0)) {
      const A = rng() >>> 0;
      const B = (c ^ A) >>> 0;
      w8(blob, 2); w32(blob, A); w32(blob, B);
    } else if (typeof c === 'number') {
      // preserve -0 (String(-0) === "0"); parseFloat("-0") reconstructs it.
      const s = Buffer.from(Object.is(c, -0) ? '-0' : String(c), 'utf8');
      w8(blob, 0); w16(blob, s.length);
      for (const b of s) blob.push(b);
    } else {
      const s = Buffer.from(String(c), 'utf8');
      w8(blob, 1); w16(blob, s.length);
      for (const b of s) blob.push(b);
    }
  }
  return blob;
}

// ---- dud (decoy) code generation ----
// Produce one decoy function's PLAIN (pre-cipher) byte stream: a syntactically
// well-formed sequence of permuted instructions terminated by RET. It is never
// referenced by any CALL/CLOSURE, so it never executes -- but once an analyst
// breaks the cipher it disassembles into believable, load-bearing-looking code,
// multiplying the surface they must understand. Operands are kept in plausible
// ranges so the decoy does not stand out as obviously bogus.
function makeDudBytes(perm, numCanon, nconsts, nlocals, rng) {
  const bytes = [];
  const starts = [0];              // byte offsets of instruction boundaries (jump targets)
  const nIns = 8 + (rng() % 20);   // larger decoys so they read like real functions
  const JUMPS = [OP.JMP, OP.JZ, OP.JNZ];
  // Prefer opcodes whose operands index existing consts/locals so the decoy is
  // internally consistent; ~1 in 4 instructions is a fake control-flow jump to a
  // plausible in-code offset, so the decoy disassembles into branchy flow.
  for (let k = 0; k < nIns; k++) {
    if (rng() % 4 === 0) {
      const jop = JUMPS[rng() % JUMPS.length];
      bytes.push(perm[jop]);
      const tgt = starts[rng() % starts.length]; // a recorded boundary (usually a back-edge)
      bytes.push(tgt & 0xff, (tgt >>> 8) & 0xff);
      starts.push(bytes.length);
      continue;
    }
    const canon = rng() % numCanon;
    if (canon === OP.RET || canon === OP.HALT || canon === OP.JMP || canon === OP.JZ || canon === OP.JNZ) { k--; continue; }
    bytes.push(perm[canon]);
    const kinds = OP_OPERANDS[canon];
    for (const kind of kinds) {
      // bound u16 operands to a plausible index space; u8 to a small count
      const cap = kind === 'u16' ? Math.max(1, Math.max(nconsts, nlocals)) : Math.max(1, nlocals || 1);
      const v = rng() % cap;
      if (kind === 'u16') bytes.push(v & 0xff, (v >>> 8) & 0xff);
      else bytes.push(v & 0xff);
    }
    starts.push(bytes.length);
  }
  bytes.push(perm[OP.PUSH_NULL]);
  bytes.push(perm[OP.RET]);
  return bytes;
}

// Build `count` decoy function images to append after the real function table.
// `startIdx` is the flat index the first decoy will occupy so its cipher key
// (which is keyed by function index) matches what the VM derives on decode.
// Disassemble a decoy's PLAIN (pre-cipher) permuted byte stream back into a
// readable canonical-opcode listing, for the build summary / UI "decoy source".
function disasmDud(plain, perm) {
  const inv = []; for (let c = 0; c < perm.length; c++) inv[perm[c]] = c;
  const out = []; let i = 0;
  while (i < plain.length) {
    const canon = inv[plain[i++]];
    if (canon === undefined) { out.push('??'); continue; }
    const kinds = OP_OPERANDS[canon] || [];
    const args = [];
    for (const kind of kinds) { if (kind === 'u16') { args.push(plain[i] | (plain[i + 1] << 8)); i += 2; } else { args.push(plain[i++]); } }
    out.push(OP_NAME[canon] + (args.length ? ' ' + args.join(', ') : ''));
  }
  return out;
}
function makeDudFunctions(count, startIdx, perm, numCanon, codeSeed, nconsts, rng) {
  const duds = [];
  for (let k = 0; k < count; k++) {
    const idx = startIdx + k;
    const nparams = rng() % 4;
    const nlocals = nparams + (rng() % 6);
    const level = rng() % 4; // 0..3 cipher rounds, mirroring selective virtualization
    const plain = makeDudBytes(perm, numCanon, nconsts, nlocals, rng);
    const enc = encRounds(plain, codeSeed, idx, level);
    const name = DUD_NAMES[rng() % DUD_NAMES.length];
    duds.push({ name, nparams, nlocals, upvals: [], protLevel: level, enc, disasm: disasmDud(plain, perm) });
  }
  return duds;
}

// Build the full protected image.  Returns { image: number[], meta }.
function buildImage(program, options = {}) {
  // The master seed drives EVERYTHING: the opcode permutation and both cipher
  // seeds are derived from it via the RNG stream. Rather than storing the
  // permutation table and the two seeds in the payload (where an analyst could
  // read them directly), we store only an obfuscated master seed and let the VM
  // regenerate the rest at load time -- so no key material sits in the image in
  // the clear. `identPerm` (development) is signalled by a header flag.
  const masterSeed = ((options.seed !== undefined ? options.seed : (Date.now() >>> 0)) >>> 0);
  // Salt is derived from the master seed (keeps builds reproducible) and baked
  // into the emitted VM, NOT the image, so the stored obfMaster looks random.
  const salt = lcgNext((masterSeed ^ 0x5bd1e995) % MASK32);
  const obfMaster = (masterSeed ^ salt) >>> 0;
  const identPerm = options.permute === false;

  const rng = makeRng(masterSeed);
  const numCanon = OP_NAME.length;

  // 1. opcode permutation, derived from the RNG (see regenPerm() in the VMs for
  //    the exact same computation). The shuffle always runs so the stream (and
  //    therefore codeSeed/constSeed) is deterministic; development overrides perm
  //    to identity afterwards, which the VM mirrors via FLAG_IDENTPERM.
  const pool = [];
  for (let i = 0; i < 256; i++) pool.push(i);
  for (let i = 255; i > 0; i--) { const j = rng() % (i + 1); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  let perm = pool.slice(0, numCanon); // perm[canonId] = emitted byte
  if (identPerm) { perm = []; for (let i = 0; i < numCanon; i++) perm.push(i); }
  const codeSeed = rng() % MASK32;
  const constSeed = rng() % MASK32;

  // 2. encrypt constant pool (optionally concealing integers as expressions)
  const constBlob = serializeConsts(program.consts, options.conceal === true, rng);
  const encConst = cipher(constBlob, constSeed);

  // 3. encode + encrypt each function
  const fnImages = program.functions.map((fn, idx) => {
    const plain = encodeFunction(fn, perm);
    // selective virtualization: @native (0) leaves bytecode in the clear; higher
    // levels apply more cipher rounds. Default 1 preserves the historical scheme.
    const level = (fn.protLevel != null) ? fn.protLevel : 1;
    const enc = encRounds(plain, codeSeed, idx, level);
    return { name: fn.name, nparams: fn.nparams, nlocals: fn.nlocals, upvals: fn.upvals || [], protLevel: level, restParam: (fn.restParam != null ? fn.restParam : 0xff), fnFlags: (fn.generator ? 1 : 0) | (fn.async ? 2 : 0), enc };
  });

  // Dud-code injection: append decoy functions to the datastream. They are
  // appended AFTER every real function so real function indices (baked into
  // CALL/CLOSURE operands) are untouched, and no instruction references them, so
  // they never run. They are covered by the function-integrity domain like any
  // real function. All draws happen here, after real content, so enabling duds
  // never perturbs the bytes of the real program for a given seed.
  const realFnCount = fnImages.length;
  let dudDisasm = [];
  if (options.dud) {
    // Default: scale decoys with program size so the real functions are diluted
    // among plausible neighbours (capped so the image does not balloon).
    const scaled = Math.min(16, 3 + Math.floor(realFnCount / 3)) + (rng() % 3);
    const count = (options.dudCount != null) ? options.dudCount : scaled;
    const duds = makeDudFunctions(count, realFnCount, perm, numCanon, codeSeed, program.consts.length, rng);
    for (const d of duds) fnImages.push(d);
    dudDisasm = duds.map((d) => ({ name: d.name, nparams: d.nparams, nlocals: d.nlocals, protLevel: d.protLevel, ops: d.disasm || [] }));
  }

  // ---- assemble body ----
  // Only the obfuscated master seed is stored; the permutation and both cipher
  // seeds are regenerated by the VM. numCanon stays (a self-check against the
  // VM's own opcode table), but the permutation bytes are no longer emitted.
  const body = [];
  w32(body, obfMaster);
  w8(body, numCanon);
  w16(body, program.consts.length);
  w32(body, encConst.length);
  for (const b of encConst) body.push(b);
  w16(body, fnImages.length);
  for (const f of fnImages) {
    const nameBytes = Buffer.from(f.name, 'utf8');
    w8(body, nameBytes.length);
    for (const b of nameBytes) body.push(b);
    w8(body, f.nparams);
    w16(body, f.nlocals);
    w8(body, f.upvals.length);
    for (const u of f.upvals) { w8(body, u.fromLocal ? 1 : 0); w16(body, u.index); }
    w8(body, f.protLevel);
    w8(body, f.restParam != null ? f.restParam : 0xff); // rest-param index, 0xff = none
    w8(body, f.fnFlags || 0); // function flags: bit0 = generator
    w32(body, f.enc.length);
    for (const b of f.enc) body.push(b);
  }

  // ---- formalized header meta (bytes 2..6) ----
  const profileName = options.profile || 'balanced';
  if (!(profileName in V.PROFILES)) throw new Error(`unknown profile '${profileName}'`);
  const archName = options.arch || 'stack-switch';
  if (!(archName in V.ARCH)) throw new Error(`unknown architecture '${archName}'`);
  const signed = typeof options.signKey === 'string' && options.signKey.length > 0;
  let flags = 0;
  if (options.optimized) flags |= V.FLAG_OPTIMIZED;
  if (options.limited) flags |= V.FLAG_LIMITED;
  if (signed) flags |= V.FLAG_SIGNED;
  flags |= V.FLAG_DERIVED; // seeds + permutation are derived, never stored
  if (identPerm) flags |= V.FLAG_IDENTPERM;
  const metaBytes = [V.FORMAT_MAJOR, V.FORMAT_MINOR, flags, V.PROFILES[profileName], V.ARCH[archName]];

  // 4. multiple independent integrity domains. Each covers a distinct region so
  //    a tamper is localized to header / dispatch table / constants / functions;
  //    the VM verifies each separately, plus a runtime self-check on load.
  let fnAll = [];
  for (const f of fnImages) fnAll = fnAll.concat(f.enc);
  const dHeader = fnv1a(metaBytes);
  const dDispatch = fnv1a(perm);
  const dConst = fnv1a(encConst);
  const dFn = fnv1a(fnAll);
  const domainBytes = [];
  w32(domainBytes, dHeader); w32(domainBytes, dDispatch); w32(domainBytes, dConst); w32(domainBytes, dFn);

  // Optional keyed signature over the body (present only when FLAG_SIGNED).
  let sigBytes = [];
  if (signed) sigBytes = keyedMac(Array.from(Buffer.from(options.signKey, 'utf8')), body);

  // The master checksum binds the header meta, the domain table, the optional
  // signature and the body, so none of them can be altered without detection.
  const checksum = fnv1a(metaBytes.concat(domainBytes).concat(sigBytes).concat(body));

  // ---- assemble image: magic | meta(5) | u32 checksum | 4x u32 domains | [8B sig] | body ----
  const image = [];
  w8(image, V.MAGIC0); // 'V'
  w8(image, V.MAGIC1); // 'G'
  for (const mb of metaBytes) w8(image, mb);
  w32(image, checksum);
  for (const db of domainBytes) image.push(db);
  for (const sb of sigBytes) image.push(sb);
  for (const b of body) image.push(b);

  return {
    image,
    meta: {
      codeSeed, constSeed, perm, checksum, salt, masterSeed, obfMaster,
      major: V.FORMAT_MAJOR, minor: V.FORMAT_MINOR, flags,
      profile: profileName, arch: archName, signed,
      domains: { header: dHeader, dispatch: dDispatch, const: dConst, fn: dFn },
      numFns: fnImages.length, realFns: realFnCount, dudFns: fnImages.length - realFnCount,
      dudDisasm,
      imageSize: image.length,
    },
  };
}

module.exports = {
  buildImage,
  // exported for tests / reuse
  mul32, lcgNext, keystreamByte, fnSeed, cipher, fnv1a, makeRng,
};
