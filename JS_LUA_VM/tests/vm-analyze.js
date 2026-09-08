#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// VM opcode table copied from the supplied interpreter
// -----------------------------------------------------------------------------

const OP = [
  'HALT',
  'PUSH_CONST',
  'PUSH_TRUE',
  'PUSH_FALSE',
  'PUSH_NULL',
  'POP',
  'DUP',
  'LOAD',
  'STORE',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'NEG',
  'NOT',
  'EQ',
  'NEQ',
  'LT',
  'GT',
  'LTE',
  'GTE',
  'BAND',
  'BOR',
  'BXOR',
  'SHL',
  'SHR',
  'JMP',
  'JZ',
  'JNZ',
  'CALL',
  'RET',
  'CALL_HOST',
  'NEW_ARR',
  'ARR_GET',
  'ARR_SET',
  'PRINT',
  'NEW_OBJ',
  'CLOSURE',
  'LOAD_UP',
  'STORE_UP',
  'LOAD_UPVALUE',
  'STORE_UPVALUE',
  'CLOSE_UPVALUE',
  'CALL_VALUE',
  'LOAD_THIS',
  'CALL_METHOD',
  'NEW',
  'NEW_VALUE',
  'TRY',
  'END_TRY',
  'THROW',
  'LOADADD',
  'LOADSUB',
  'LOADLT',
  'CONSTADD',
  'AWAIT'
];

const EXPECTED_OPCOUNT = 57;
const MASK32 = 0x100000000;

// -----------------------------------------------------------------------------
// 32-bit arithmetic matching the original VM
// -----------------------------------------------------------------------------

function mul32(a, b) {
  a = a % MASK32;
  b = b % MASK32;

  const ah = Math.floor(a / 65536);
  const al = a % 65536;

  const r =
    ((ah * b) % 65536) * 65536 +
    al * b;

  return r % MASK32;
}

function lcgNext(s) {
  return (
    mul32(s, 1664525) +
    1013904223
  ) % MASK32;
}

function ksByte(s) {
  return Math.floor(s / 16777216) % 256;
}

function fnSeed(codeSeed, idx) {
  return (
    codeSeed +
    mul32(idx, 2654435761)
  ) % MASK32;
}

function roundSeed(codeSeed, idx, round) {
  if (round === 0)
    return fnSeed(codeSeed, idx);

  return (
    fnSeed(codeSeed, idx) +
    mul32(round, 2246822519)
  ) % MASK32;
}

function cipher(bytes, seed) {
  let state = seed % MASK32;
  const out = new Array(bytes.length);

  for (let i = 0; i < bytes.length; i++) {
    state = lcgNext(state);
    out[i] = (bytes[i] ^ ksByte(state)) & 0xff;
  }

  return out;
}

function decRounds(bytes, codeSeed, idx, rounds) {
  let out = bytes;

  for (let r = 0; r < rounds; r++) {
    out = cipher(
      out,
      roundSeed(codeSeed, idx, r)
    );
  }

  return out;
}

// -----------------------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------------------

function fnv1a(bytes) {
  let h = 2166136261;

  for (const byte of bytes) {
    const low = h % 256;

    h =
      h -
      low +
      (low ^ byte);

    h = mul32(h, 16777619);
  }

  return h % MASK32;
}

function u32(bytes, offset = 0) {
  return (
    bytes[offset] +
    bytes[offset + 1] * 256 +
    bytes[offset + 2] * 65536 +
    bytes[offset + 3] * 16777216
  ) >>> 0;
}

function u16(bytes, offset = 0) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8)
  ) >>> 0;
}

function hex(n) {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

function hexBytes(bytes) {
  return Buffer.from(bytes)
    .toString('hex')
    .match(/.{1,2}/g)
    ?.join(' ') || '';
}

// -----------------------------------------------------------------------------
// Extract IMAGE_B64 from the JavaScript wrapper
// -----------------------------------------------------------------------------

function extractImage(source) {
  const match = source.match(
    /var\s+IMAGE_B64\s*=\s*"([^"]+)"/
  );

  if (!match) {
    throw new Error(
      'Could not find IMAGE_B64 in input JavaScript'
    );
  }

  return match[1];
}

// -----------------------------------------------------------------------------
// Parse VM image
// -----------------------------------------------------------------------------

function parseImage(base64) {
  const b = Array.from(
    Buffer.from(base64, 'base64')
  );

  if (b.length < 27) {
    throw new Error('Image is too small');
  }

  if (b[0] !== 0x56 || b[1] !== 0x47) {
    throw new Error('Bad VM image magic');
  }

  const major = b[2];
  const minor = b[3];
  const flags = b[4];
  const profile = b[5];
  const arch = b[6];

  const checksum = u32(b, 7);

  const meta = b.slice(2, 7);
  const domainBytes = b.slice(11, 27);

  const domains = {
    header: u32(domainBytes, 0),
    dispatch: u32(domainBytes, 4),
    constants: u32(domainBytes, 8),
    functions: u32(domainBytes, 12)
  };

  const signed = (flags & 4) !== 0;

  const signature = signed
    ? b.slice(27, 35)
    : [];

  const body = b.slice(
    signed ? 35 : 27
  );

  const actualMaster = fnv1a(
    meta
      .concat(domainBytes)
      .concat(signature)
      .concat(body)
  );

  const domainsValid = {
    master:
      actualMaster === checksum,

    header:
      fnv1a(meta) === domains.header,

    dispatch: null,

    constants: null,

    functions: null
  };

  let p = 0;

  function read8() {
    return body[p++];
  }

  function read16() {
    const v = u16(body, p);
    p += 2;
    return v;
  }

  function read32() {
    const v = u32(body, p);
    p += 4;
    return v;
  }

  const codeSeed = read32();
  const constSeed = read32();

  const numCanon = read8();

  if (numCanon !== EXPECTED_OPCOUNT) {
    console.warn(
      `WARNING: expected ${EXPECTED_OPCOUNT} opcodes, image has ${numCanon}`
    );
  }

  const byteToCanonical = {};
  const permutation = [];

  for (let i = 0; i < numCanon; i++) {
    const encodedOpcode = read8();

    byteToCanonical[encodedOpcode] = i;
    permutation.push(encodedOpcode);
  }

  domainsValid.dispatch =
    fnv1a(permutation) === domains.dispatch;

  const constCount = read16();
  const encodedConstLength = read32();

  const encodedConstants =
    body.slice(
      p,
      p + encodedConstLength
    );

  p += encodedConstLength;

  domainsValid.constants =
    fnv1a(encodedConstants) === domains.constants;

  const decryptedConstants =
    cipher(
      encodedConstants,
      constSeed
    );

  const constants = [];

  let cp = 0;

  for (let i = 0; i < constCount; i++) {
    const tag = decryptedConstants[cp++];

    if (tag === 2) {
      const A = u32(
        decryptedConstants,
        cp
      );
      cp += 4;

      const B = u32(
        decryptedConstants,
        cp
      );
      cp += 4;

      constants.push({
        type: 'integer',
        value: (A ^ B) >>> 0
      });

      continue;
    }

    const len = u16(
      decryptedConstants,
      cp
    );

    cp += 2;

    const raw =
      decryptedConstants.slice(
        cp,
        cp + len
      );

    cp += len;

    const str =
      Buffer.from(raw).toString('utf8');

    if (tag === 0) {
      constants.push({
        type: 'number',
        value: Number.parseFloat(str)
      });
    } else {
      constants.push({
        type: 'string',
        value: str
      });
    }
  }

  const fnCount = read16();

  const functions = [];
  const encodedAllFunctions = [];

  for (let f = 0; f < fnCount; f++) {
    const nameLength = read8();

    const name =
      Buffer.from(
        body.slice(p, p + nameLength)
      ).toString('utf8');

    p += nameLength;

    const nparams = read8();
    const nlocals = read16();
    const nUp = read8();

    const upvalues = [];

    for (let i = 0; i < nUp; i++) {
      const flags = read8();
      const index = read16();

      upvalues.push({
        fromLocal: flags === 1,
        index
      });
    }

    const protectionRounds = read8();

    const codeLength = read32();

    const encodedCode =
      body.slice(
        p,
        p + codeLength
      );

    p += codeLength;

    encodedAllFunctions.push(
      ...encodedCode
    );

    const decryptedCode =
      decRounds(
        encodedCode,
        codeSeed,
        f,
        protectionRounds
      );

    functions.push({
      index: f,
      name,
      params: nparams,
      locals: nlocals,
      upvalues,
      protectionRounds,
      encodedCode,
      code: decryptedCode
    });
  }

  domainsValid.functions =
    fnv1a(encodedAllFunctions) ===
    domains.functions;

  return {
    raw: b,
    major,
    minor,
    flags,
    profile,
    arch,
    checksum,
    domains,
    domainsValid,
    signed,
    signature,
    body,
    codeSeed,
    constSeed,
    permutation,
    byteToCanonical,
    constants,
    functions
  };
}

// -----------------------------------------------------------------------------
// Instruction decoding
// -----------------------------------------------------------------------------

function instructionSize(op) {
  switch (op) {
    case 1:  // PUSH_CONST
    case 7:  // LOAD
    case 8:  // STORE
    case 39: // LOAD_UP
    case 40: // STORE_UP
    case 41: // LOAD_UPVALUE
    case 42: // STORE_UPVALUE
    case 38: // CLOSURE
    case 27: // JMP
    case 28: // JZ
    case 29: // JNZ
    case 30: // CALL
    case 32: // CALL_HOST
    case 46: // CALL_METHOD
    case 47: // NEW
    case 48: // NEW_VALUE
    case 49: // TRY
      return op === 30 ||
             op === 32 ||
             op === 46
        ? 3
        : 2;

    case 33: // NEW_ARR
    case 37: // NEW_OBJ
      return 2;

    case 44: // CALL_VALUE
      return 1;

    default:
      return 0;
  }
}

function operandText(
  op,
  code,
  ip,
  constants,
  functionCount
) {
  const b1 = code[ip + 1];
  const b2 = code[ip + 2];

  switch (op) {
    case 1: {
      const idx = b1 | (b2 << 8);
      return {
        size: 3,
        text: `#${idx} ${formatConstant(constants[idx])}`
      };
    }

    case 7:
    case 8:
    case 39:
    case 40:
    case 41:
    case 42: {
      const idx = b1 | (b2 << 8);

      return {
        size: 3,
        text: String(idx)
      };
    }

    case 27:
    case 28:
    case 29:
    case 49: {
      const addr = b1 | (b2 << 8);

      return {
        size: 3,
        text: `${addr} (0x${addr.toString(16)})`
      };
    }

    case 38: {
      const fn = b1 | (b2 << 8);

      return {
        size: 3,
        text:
          `fn#${fn}` +
          (fn < functionCount
            ? ` (${fn})`
            : ' [INVALID]')
      };
    }

    case 30: {
      const fn = b1 | (b2 << 8);
      const argc = code[ip + 3];

      return {
        size: 4,
        text: `fn#${fn}, argc=${argc}`
      };
    }

    case 32: {
      const idx = b1 | (b2 << 8);
      const argc = code[ip + 3];

      return {
        size: 4,
        text:
          `#${idx} ${formatConstant(constants[idx])}, argc=${argc}`
      };
    }

    case 33:
    case 37: {
      const n = b1 | (b2 << 8);

      return {
        size: 3,
        text: String(n)
      };
    }

    case 44:
      return {
        size: 2,
        text: `argc=${b1}`
      };

    case 46: {
      const method = b1 | (b2 << 8);
      const argc = code[ip + 3];

      return {
        size: 4,
        text: `method=${method}, argc=${argc}`
      };
    }

    case 47:
    case 48: {
      const argc = b1;

      return {
        size: 2,
        text: `argc=${argc}`
      };
    }

    default:
      return {
        size: 1,
        text: ''
      };
  }
}

function formatConstant(c) {
  if (!c) return '<invalid-constant>';

  if (c.type === 'string')
    return JSON.stringify(c.value);

  return String(c.value);
}

function disassemble(fn, image) {
  const code = fn.code;
  const lines = [];

  let ip = 0;

  while (ip < code.length) {
    const encoded = code[ip];

    const canonical =
      image.byteToCanonical[encoded];

    if (
      canonical === undefined ||
      canonical >= OP.length
    ) {
      lines.push(
        `${String(ip).padStart(4)}  ` +
        `${hex(encoded).slice(-2)}        ` +
        `UNKNOWN_OPCODE ${hex(encoded)}`
      );

      ip++;
      continue;
    }

    const name = OP[canonical];

    const decoded =
      operandText(
        canonical,
        code,
        ip,
        image.constants,
        image.functions.length
      );

    const raw =
      code
        .slice(ip, ip + decoded.size)
        .map(
          x => x.toString(16).padStart(2, '0')
        )
        .join(' ');

    lines.push(
      `${String(ip).padStart(4)}  ` +
      `${raw.padEnd(14)} ` +
      `${name.padEnd(16)} ` +
      decoded.text
    );

    ip += decoded.size;
  }

  return lines;
}

// -----------------------------------------------------------------------------
// Human-readable report
// -----------------------------------------------------------------------------

function printReport(image) {
  console.log('\n' + '='.repeat(72));
  console.log('VM-GEN IMAGE ANALYSIS');
  console.log('='.repeat(72));

  console.log('\n[IMAGE]');
  console.log(`Format       : ${image.major}.${image.minor}`);
  console.log(`Flags        : ${hex(image.flags)}`);
  console.log(`Profile      : ${image.profile}`);
  console.log(`Architecture : ${image.arch}`);
  console.log(`Image size   : ${image.raw.length} bytes`);
  console.log(`Signed       : ${image.signed}`);
  console.log(`Checksum     : ${hex(image.checksum)}`);

  console.log('\n[SEEDS]');
  console.log(`Code seed    : ${hex(image.codeSeed)}`);
  console.log(`Const seed   : ${hex(image.constSeed)}`);

  console.log('\n[INTEGRITY DOMAINS]');
  for (const [name, valid] of
       Object.entries(image.domainsValid)) {
    console.log(
      `${name.padEnd(12)} : ${valid ? 'OK' : 'FAILED'}`
    );
  }

  console.log('\n[DOMAIN HASHES]');
  for (const [name, value] of
       Object.entries(image.domains)) {
    console.log(
      `${name.padEnd(12)} : ${hex(value)}`
    );
  }

  if (image.signed) {
    console.log('\n[SIGNATURE]');
    console.log(
      `Signature     : ${hexBytes(image.signature)}`
    );

    console.log(
      'Authorization : not checked by analyzer'
    );
    console.log(
      '               (set VMGEN_KEY to verify it)'
    );
  }

  console.log('\n[OPCODE PERMUTATION]');
  console.log(
    'Encoded byte -> canonical opcode'
  );

  for (let i = 0; i < image.permutation.length; i++) {
    const encoded = image.permutation[i];

    console.log(
      `  ${encoded.toString(16).padStart(2, '0')} -> ` +
      `${String(i).padStart(2)} ${OP[i]}`
    );
  }

  console.log('\n[CONSTANT POOL]');
  console.log(
    `Count: ${image.constants.length}`
  );

  image.constants.forEach((c, i) => {
    console.log(
      `  [${i}] ${c.type.padEnd(8)} ${formatConstant(c)}`
    );
  });

  console.log('\n[FUNCTIONS]');
  console.log(
    `Count: ${image.functions.length}`
  );

  for (const fn of image.functions) {
    console.log('\n' + '-'.repeat(72));

    console.log(
      `Function #${fn.index}: ${fn.name}`
    );

    console.log(
      `  parameters       : ${fn.params}`
    );

    console.log(
      `  locals           : ${fn.locals}`
    );

    console.log(
      `  upvalues         : ${fn.upvalues.length}`
    );

    for (const up of fn.upvalues) {
      console.log(
        `    ${up.fromLocal ? 'local' : 'upvalue'}[${up.index}]`
      );
    }

    console.log(
      `  protection rounds: ${fn.protectionRounds}`
    );

    console.log(
      `  encoded length   : ${fn.encodedCode.length}`
    );

    console.log(
      `  decrypted length : ${fn.code.length}`
    );

    console.log('\n  DISASSEMBLY:');

    for (const line of
         disassemble(fn, image)) {
      console.log('    ' + line);
    }
  }

  console.log('\n' + '='.repeat(72));
}

// -----------------------------------------------------------------------------
// Optional JSON output
// -----------------------------------------------------------------------------

function jsonReport(image) {
  return {
    format: {
      major: image.major,
      minor: image.minor,
      flags: image.flags,
      profile: image.profile,
      arch: image.arch
    },

    signed: image.signed,

    integrity: image.domainsValid,

    seeds: {
      code: image.codeSeed,
      constants: image.constSeed
    },

    domains: image.domains,

    opcodePermutation:
      image.permutation.map(
        (encoded, canonical) => ({
          encoded,
          canonical,
          name: OP[canonical]
        })
      ),

    constants: image.constants,

    functions: image.functions.map(fn => ({
      index: fn.index,
      name: fn.name,
      params: fn.params,
      locals: fn.locals,
      upvalues: fn.upvalues,
      protectionRounds: fn.protectionRounds,
      codeLength: fn.code.length,

      instructions:
        disassemble(fn, image)
    }))
  };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function usage() {
  console.log(`
Usage:

  node vm-analyze.js protected.js
  node vm-analyze.js protected.js --json
  node vm-analyze.js protected.js --constants
  node vm-analyze.js protected.js --functions

Examples:

  node vm-analyze.js vm.js

  node vm-analyze.js vm.js --json > analysis.json

  VMGEN_KEY="your-key" node vm-analyze.js vm.js
`);
}

const args = process.argv.slice(2);

if (!args.length || args.includes('--help')) {
  usage();
  process.exit(0);
}

const input = args.find(
  x => !x.startsWith('--')
);

if (!input) {
  usage();
  process.exit(1);
}

if (!fs.existsSync(input)) {
  console.error(
    `Input file not found: ${input}`
  );
  process.exit(1);
}

try {
  const source =
    fs.readFileSync(input, 'utf8');

  const base64 =
    extractImage(source);

  console.error(
    `[+] Extracted IMAGE_B64 (${base64.length} chars)`
  );

  const image =
    parseImage(base64);

  console.error(
    `[+] Parsed ${image.functions.length} functions`
  );

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        jsonReport(image),
        null,
        2
      )
    );
  } else {
    printReport(image);
  }

} catch (err) {
  console.error(
    '\n[!] Analysis failed: ' +
    err.message
  );

  if (process.env.DEBUG) {
    console.error(err.stack);
  }

  process.exit(1);
}
