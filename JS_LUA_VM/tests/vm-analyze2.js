#!/usr/bin/env node
'use strict';

/*
 * vm-decompile.js
 *
 * Best-effort decompiler for the vm-gen VM format shown in the supplied
 * protected JavaScript wrapper.
 *
 * Usage:
 *
 *   node vm-decompile.js protected.js
 *   node vm-decompile.js protected.js -o reconstructed.js
 *   node vm-decompile.js protected.js --json
 *
 * This program DOES NOT execute the recovered VM bytecode.
 */

const fs = require('fs');

// ============================================================================
// VM DEFINITIONS
// ============================================================================

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

const MASK32 = 0x100000000;

// ============================================================================
// LOW-LEVEL HELPERS
// ============================================================================

function mul32(a, b) {
  a %= MASK32;
  b %= MASK32;

  const ah = Math.floor(a / 65536);
  const al = a % 65536;

  return (
    ((ah * b) % 65536) * 65536 +
    al * b
  ) % MASK32;
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

function roundSeed(cs, idx, r) {
  if (r === 0)
    return fnSeed(cs, idx);

  return (
    fnSeed(cs, idx) +
    mul32(r, 2246822519)
  ) % MASK32;
}

function cipher(bytes, seed) {
  let state = seed % MASK32;
  const out = new Array(bytes.length);

  for (let i = 0; i < bytes.length; i++) {
    state = lcgNext(state);
    out[i] =
      (bytes[i] ^ ksByte(state)) & 0xff;
  }

  return out;
}

function decRounds(bytes, cs, idx, rounds) {
  let out = bytes;

  for (let r = 0; r < rounds; r++)
    out = cipher(
      out,
      roundSeed(cs, idx, r)
    );

  return out;
}

function fnv1a(bytes) {
  let h = 2166136261;

  for (const b of bytes) {
    const low = h % 256;
    h =
      h -
      low +
      (low ^ b);

    h = mul32(h, 16777619);
  }

  return h % MASK32;
}

function u16(b, p) {
  return (
    b[p] |
    (b[p + 1] << 8)
  ) >>> 0;
}

function u32(b, p) {
  return (
    b[p] +
    b[p + 1] * 256 +
    b[p + 2] * 65536 +
    b[p + 3] * 16777216
  ) >>> 0;
}

// ============================================================================
// IMAGE EXTRACTION
// ============================================================================

function extractImage(source) {
  const m = source.match(
    /var\s+IMAGE_B64\s*=\s*"([^"]+)"/
  );

  if (!m)
    throw new Error('IMAGE_B64 was not found');

  return Buffer.from(
    m[1],
    'base64'
  );
}

// ============================================================================
// IMAGE PARSER
// ============================================================================

function parseImage(image) {
  // Normalize Buffer -> Array because the VM's original implementation
  // operates on JavaScript arrays.
  image = Array.from(image);

  if (
    image[0] !== 0x56 ||
    image[1] !== 0x47
  ) {
    throw new Error('Invalid VG image');
  }

  const major = image[2];
  const minor = image[3];
  const flags = image[4];

  if (major !== 2) {
    throw new Error(
      `Unsupported image version ${major}.${minor}`
    );
  }

  const checksum = u32(image, 7);

  // IMPORTANT: arrays, not Buffers.
  const meta = image.slice(2, 7);
  const domainBytes = image.slice(11, 27);

  const dHeader = u32(domainBytes, 0);
  const dDispatch = u32(domainBytes, 4);
  const dConst = u32(domainBytes, 8);
  const dFn = u32(domainBytes, 12);

  const signed = (flags & 4) !== 0;

  const sigBytes = signed
    ? image.slice(27, 35)
    : [];

  const body = image.slice(
    signed ? 35 : 27
  );

  // Reproduce the VM's master integrity check.
  const integrityBytes =
    meta
      .concat(domainBytes)
      .concat(sigBytes)
      .concat(body);

  const master = fnv1a(integrityBytes);

  if (master !== checksum) {
    throw new Error(
      `Image integrity check failed ` +
      `(expected ${checksum >>> 0}, got ${master >>> 0})`
    );
  }

  if (fnv1a(meta) !== dHeader) {
    throw new Error(
      'Header integrity check failed'
    );
  }

  let p = 0;

  function read8() {
    if (p >= body.length)
      throw new Error(
        'Unexpected end of VM image'
      );

    return body[p++];
  }

  function read16() {
    if (p + 2 > body.length)
      throw new Error(
        'Unexpected end of VM image'
      );

    const v =
      body[p] |
      (body[p + 1] << 8);

    p += 2;

    return v >>> 0;
  }

  function read32() {
    if (p + 4 > body.length)
      throw new Error(
        'Unexpected end of VM image'
      );

    const v =
      body[p] +
      body[p + 1] * 256 +
      body[p + 2] * 65536 +
      body[p + 3] * 16777216;

    p += 4;

    return v >>> 0;
  }

  const codeSeed = read32();
  const constSeed = read32();

  const opcodeCount = read8();

  const byteToCanonical =
    Object.create(null);

  const permutation = [];

  for (
    let i = 0;
    i < opcodeCount;
    i++
  ) {
    const encodedOpcode = read8();

    byteToCanonical[encodedOpcode] = i;
    permutation.push(encodedOpcode);
  }

  if (
    fnv1a(permutation) !== dDispatch
  ) {
    throw new Error(
      'Opcode dispatch integrity check failed'
    );
  }

  const constCount = read16();
  const encodedConstLength = read32();

  if (
    p + encodedConstLength >
    body.length
  ) {
    throw new Error(
      'Constant pool extends beyond image'
    );
  }

  const encodedConstants =
    body.slice(
      p,
      p + encodedConstLength
    );

  p += encodedConstLength;

  if (
    fnv1a(encodedConstants) !== dConst
  ) {
    throw new Error(
      'Constant-pool integrity check failed'
    );
  }

  const decryptedConstants =
    cipher(
      encodedConstants,
      constSeed
    );

  const constants = [];
  let cp = 0;

  for (
    let i = 0;
    i < constCount;
    i++
  ) {
    if (cp >= decryptedConstants.length) {
      throw new Error(
        'Constant pool is truncated'
      );
    }

    const tag =
      decryptedConstants[cp++];

    if (tag === 2) {
      if (
        cp + 8 >
        decryptedConstants.length
      ) {
        throw new Error(
          'Truncated integer constant'
        );
      }

      const A =
        u32(
          decryptedConstants,
          cp
        );

      cp += 4;

      const B =
        u32(
          decryptedConstants,
          cp
        );

      cp += 4;

      constants.push({
        type: 'number',
        value: (A ^ B) >>> 0
      });

      continue;
    }

    if (
      tag !== 0 &&
      tag !== 1
    ) {
      throw new Error(
        `Unknown constant tag ${tag} at index ${i}`
      );
    }

    if (
      cp + 2 >
      decryptedConstants.length
    ) {
      throw new Error(
        'Truncated constant length'
      );
    }

    const len =
      decryptedConstants[cp] |
      (decryptedConstants[cp + 1] << 8);

    cp += 2;

    if (
      cp + len >
      decryptedConstants.length
    ) {
      throw new Error(
        'Truncated constant data'
      );
    }

    const raw =
      decryptedConstants.slice(
        cp,
        cp + len
      );

    cp += len;

    const value =
      Buffer.from(raw)
        .toString('utf8');

    if (tag === 0) {
      constants.push({
        type: 'number',
        value: Number.parseFloat(value)
      });
    } else {
      constants.push({
        type: 'string',
        value
      });
    }
  }

  const fnCount = read16();

  const functions = [];
  const allEncodedCode = [];

  for (
    let fi = 0;
    fi < fnCount;
    fi++
  ) {
    const nameLength = read8();

    if (
      p + nameLength >
      body.length
    ) {
      throw new Error(
        `Truncated function name #${fi}`
      );
    }

    const name =
      Buffer.from(
        body.slice(
          p,
          p + nameLength
        )
      ).toString('utf8');

    p += nameLength;

    const params = read8();
    const locals = read16();
    const upCount = read8();

    const upvalues = [];

    for (
      let u = 0;
      u < upCount;
      u++
    ) {
      const flags = read8();
      const index = read16();

      upvalues.push({
        fromLocal: flags === 1,
        index
      });
    }

    const rounds = read8();
    const codeLength = read32();

    if (
      p + codeLength >
      body.length
    ) {
      throw new Error(
        `Function ${fi} bytecode is truncated`
      );
    }

    const encodedCode =
      body.slice(
        p,
        p + codeLength
      );

    p += codeLength;

    allEncodedCode.push(
      ...encodedCode
    );

    const code =
      decRounds(
        encodedCode,
        codeSeed,
        fi,
        rounds
      );

    functions.push({
      index: fi,
      name,
      params,
      locals,
      upvalues,
      rounds,
      code
    });
  }

  if (
    fnv1a(allEncodedCode) !== dFn
  ) {
    throw new Error(
      'Function integrity check failed'
    );
  }

  return {
    constants,
    functions,
    byteToCanonical,
    seeds: {
      code: codeSeed,
      constants: constSeed
    }
  };
}
// ============================================================================
// BYTECODE DECODER
// ============================================================================

function decodeInstructions(fn, image) {
  const code = fn.code;
  const result = [];
  let ip = 0;

  function read16At(pos) {
    if (pos + 1 >= code.length) {
      throw new Error(
        `Truncated operand at ${pos}`
      );
    }

    return (
      code[pos] |
      (code[pos + 1] << 8)
    ) >>> 0;
  }

  while (ip < code.length) {
    const start = ip;
    const encoded = code[ip++];

    const opcode =
      image.byteToCanonical[encoded];

    if (
      opcode === undefined ||
      opcode >= OP.length
    ) {
      result.push({
        ip: start,
        op: -1,
        name: 'UNKNOWN',
        args: []
      });

      continue;
    }

    const name = OP[opcode];
    const args = [];

    switch (name) {
      case 'PUSH_CONST':
      case 'LOAD':
      case 'STORE':
      case 'LOAD_UP':
      case 'STORE_UP':
      case 'LOAD_UPVALUE':
      case 'STORE_UPVALUE':
      case 'CLOSURE':
      case 'JMP':
      case 'JZ':
      case 'JNZ':
      case 'TRY':
      case 'NEW_ARR':
      case 'NEW_OBJ': {
        const value =
          read16At(ip);

        ip += 2;
        args.push(value);
        break;
      }

      case 'CALL':
      case 'CALL_HOST':
      case 'CALL_METHOD': {
        const target =
          read16At(ip);

        ip += 2;

        if (ip >= code.length)
          throw new Error(
            `Truncated argc at ${ip}`
          );

        const argc =
          code[ip++];

        args.push(
          target,
          argc
        );

        break;
      }

      case 'CALL_VALUE':
      case 'NEW':
      case 'NEW_VALUE': {
        if (ip >= code.length)
          throw new Error(
            `Truncated argument count at ${ip}`
          );

        args.push(
          code[ip++]
        );

        break;
      }

      default:
        break;
    }

    result.push({
      ip: start,
      op: opcode,
      name,
      args
    });
  }

  return result;
}

// ============================================================================
// EXPRESSION MODEL
// ============================================================================

class Expr {
  constructor(code, precedence = 100) {
    this.code = code;
    this.precedence = precedence;
  }

  toString() {
    return this.code;
  }
}

function lit(value) {
  if (
    value === null ||
    value === undefined
  )
    return new Expr('null');

  if (typeof value === 'string')
    return new Expr(
      JSON.stringify(value)
    );

  return new Expr(String(value));
}

function variable(name) {
  return new Expr(name);
}

function unary(op, a) {
  return new Expr(
    `${op}${a.code}`,
    80
  );
}

function binary(a, op, b, precedence = 50) {
  return new Expr(
    `(${a.code} ${op} ${b.code})`,
    precedence
  );
}

function member(obj, key) {
  return new Expr(
    `${obj.code}[${key.code}]`,
    90
  );
}

function callExpr(fn, args) {
  return new Expr(
    `${fn.code}(${args.map(x => x.code).join(', ')})`,
    90
  );
}

// ============================================================================
// VARIABLE NAMING
// ============================================================================

function sanitizeIdentifier(name) {
  let s = String(name || '')
    .replace(/[^A-Za-z0-9_$]/g, '_');

  if (!s)
    s = 'fn';

  if (/^[0-9]/.test(s))
    s = '_' + s;

  return s;
}

function localName(index) {
  return `v${index}`;
}

// ============================================================================
// HOST CALL RECONSTRUCTION
// ============================================================================

function hostCall(name, args) {
  const a =
    args.map(x => x.code);

  switch (name) {
    case 'len':
      return new Expr(
        `(${a[0]}).length`
      );

    case 'str':
      return new Expr(
        `String(${a.join(', ')})`
      );

    case 'num':
      return new Expr(
        `parseFloat(${a.join(', ')})`
      );

    case 'floor':
      return new Expr(
        `Math.floor(${a.join(', ')})`
      );

    case 'abs':
      return new Expr(
        `Math.abs(${a.join(', ')})`
      );

    case 'rand':
      return new Expr(
        'Math.random()'
      );

    case 'time':
      return new Expr(
        'Date.now()'
      );

    case 'push':
      return new Expr(
        `${a[0]}.push(${a[1]})`
      );

    case 'keys':
      return new Expr(
        `Object.keys(${a[0]})`
      );

    case 'has':
      return new Expr(
        `${a[0]}.hasOwnProperty(${a[1]})`
      );

    case 'typeof':
      return new Expr(
        `typeof ${a[0]}`
      );

    case 'bitnot':
      return new Expr(
        `~(${a[0]})`
      );

    case 'pow':
      return new Expr(
        `Math.pow(${a[0]}, ${a[1]})`
      );

    case 'instanceof':
      return new Expr(
        `(${a[0]} instanceof ${a[1]})`
      );

    case 'inop':
      return new Expr(
        `(${a[0]} in ${a[1]})`
      );

    case 'require':
      return new Expr(
        `require(${a[0]})`
      );

    case '__new':
      return new Expr(
        `new ${a[0]}(${a.slice(1).join(', ')})`
      );

    default:
      return new Expr(
        `__vm_${sanitizeIdentifier(name)}(${a.join(', ')})`
      );
  }
}

// ============================================================================
// BASIC BLOCK / CONTROL-FLOW ANALYSIS
// ============================================================================

function findLeaders(instructions) {
  const leaders =
    new Set([0]);

  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i];

    if (
      ins.name === 'JMP' ||
      ins.name === 'JZ' ||
      ins.name === 'JNZ'
    ) {
      leaders.add(ins.args[0]);

      if (i + 1 < instructions.length)
        leaders.add(
          instructions[i + 1].ip
        );
    }

    if (
      ins.name === 'TRY'
    ) {
      leaders.add(ins.args[0]);
    }
  }

  return [...leaders].sort(
    (a, b) => a - b
  );
}

function buildBlocks(instructions) {
  const leaders =
    findLeaders(instructions);

  const byIp =
    new Map(
      instructions.map(
        x => [x.ip, x]
      )
    );

  const blocks = [];

  for (
    let i = 0;
    i < leaders.length;
    i++
  ) {
    const start = leaders[i];

    const end =
      i + 1 < leaders.length
        ? leaders[i + 1]
        : Infinity;

    const block =
      instructions.filter(
        ins =>
          ins.ip >= start &&
          ins.ip < end
      );

    if (block.length) {
      blocks.push({
        id: blocks.length,
        start,
        instructions: block,
        successors: []
      });
    }
  }

  const blockByIp =
    new Map(
      blocks.map(
        b => [b.start, b]
      )
    );

  for (const block of blocks) {
    const last =
      block.instructions[
        block.instructions.length - 1
      ];

    if (!last)
      continue;

    if (last.name === 'JMP') {
      const target =
        blockByIp.get(last.args[0]);

      if (target)
        block.successors.push(target.id);

    } else if (
      last.name === 'JZ' ||
      last.name === 'JNZ'
    ) {
      const target =
        blockByIp.get(last.args[0]);

      if (target)
        block.successors.push(target.id);

      const next =
        blocks[block.id + 1];

      if (next)
        block.successors.push(next.id);

    } else if (
      last.name !== 'RET' &&
      last.name !== 'HALT' &&
      last.name !== 'THROW'
    ) {
      const next =
        blocks[block.id + 1];

      if (next)
        block.successors.push(next.id);
    }
  }

  return blocks;
}

// ============================================================================
// SYMBOLIC FUNCTION DECOMPILER
// ============================================================================

function decompileFunction(fn, image) {
  const instructions =
    decodeInstructions(fn, image);

  const blocks =
    buildBlocks(instructions);

  const constants =
    image.constants;

  const lines = [];

  const indent = n =>
    '    '.repeat(n);

  const declared =
    new Set();

  const stack = [];

  function push(x) {
    stack.push(x);
  }

  function pop() {
    return stack.pop() ||
      variable('undefined');
  }

  function emit(line, level = 1) {
    lines.push(
      indent(level) + line
    );
  }

  function constant(index) {
    const c =
      constants[index];

    if (!c)
      return lit(null);

    return lit(c.value);
  }

  function ensureLocal(index) {
    const name =
      localName(index);

    if (!declared.has(index)) {
      declared.add(index);

      emit(
        `let ${name};`
      );
    }

    return variable(name);
  }

  /*
   * The block-level translator intentionally keeps control-flow comments
   * where the original structure cannot be proven safely. This is preferable
   * to producing syntactically attractive but incorrect JavaScript.
   */

  const blockOutput =
    new Map();

  for (const block of blocks) {
    const out = [];

    const bpush =
      x => stack.push(x);

    const bpop =
      () =>
        stack.pop() ||
        variable('undefined');

    for (const ins of block.instructions) {
      const n = ins.name;
      const a = ins.args;

      switch (n) {
        case 'PUSH_CONST':
          bpush(
            constant(a[0])
          );
          break;

        case 'PUSH_TRUE':
          bpush(lit(true));
          break;

        case 'PUSH_FALSE':
          bpush(lit(false));
          break;

        case 'PUSH_NULL':
          bpush(lit(null));
          break;

        case 'DUP': {
          const x =
            stack[stack.length - 1] ||
            variable('undefined');

          bpush(x);
          break;
        }

        case 'POP':
          bpop();
          break;

        case 'LOAD': {
          const v =
            ensureLocal(a[0]);

          bpush(v);
          break;
        }

        case 'STORE': {
          const value =
            bpop();

          const v =
            ensureLocal(a[0]);

          out.push(
            `${v.code} = ${value.code};`
          );

          break;
        }

        case 'ADD': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '+', b)
          );

          break;
        }

        case 'SUB': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '-', b)
          );

          break;
        }

        case 'MUL': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '*', b)
          );

          break;
        }

        case 'DIV': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '/', b)
          );

          break;
        }

        case 'MOD': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '%', b)
          );

          break;
        }

        case 'NEG':
          bpush(
            unary('-', bpop())
          );
          break;

        case 'NOT':
          bpush(
            unary('!', bpop())
          );
          break;

        case 'EQ': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '===', b)
          );

          break;
        }

        case 'NEQ': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '!==', b)
          );

          break;
        }

        case 'LT': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '<', b)
          );

          break;
        }

        case 'GT': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '>', b)
          );

          break;
        }

        case 'LTE': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '<=', b)
          );

          break;
        }

        case 'GTE': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '>=', b)
          );

          break;
        }

        case 'BAND': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '&', b)
          );

          break;
        }

        case 'BOR': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '|', b)
          );

          break;
        }

        case 'BXOR': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '^', b)
          );

          break;
        }

        case 'SHL': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '<<', b)
          );

          break;
        }

        case 'SHR': {
          const b = bpop();
          const c = bpop();

          bpush(
            binary(c, '>>>', b)
          );

          break;
        }

        case 'ARR_GET': {
          const index =
            bpop();

          const object =
            bpop();

          bpush(
            member(object, index)
          );

          break;
        }

        case 'ARR_SET': {
          const value =
            bpop();

          const index =
            bpop();

          const object =
            bpop();

          out.push(
            `${object.code}[${index.code}] = ${value.code};`
          );

          bpush(value);

          break;
        }

        case 'PRINT': {
          const value =
            bpop();

          out.push(
            `console.log(${value.code});`
          );

          break;
        }

        case 'NEW_ARR': {
          const values = [];

          for (
            let i = 0;
            i < a[0];
            i++
          ) {
            values.unshift(
              bpop()
            );
          }

          bpush(
            new Expr(
              `[${values.map(x => x.code).join(', ')}]`
            )
          );

          break;
        }

        case 'NEW_OBJ': {
          const pairs = [];

          for (
            let i = 0;
            i < a[0];
            i++
          ) {
            const value =
              bpop();

            const key =
              bpop();

            pairs.unshift(
              `${key.code}: ${value.code}`
            );
          }

          bpush(
            new Expr(
              `{ ${pairs.join(', ')} }`
            )
          );

          break;
        }

        case 'CALL_HOST': {
          const hostName =
            constants[a[0]]
              ? constants[a[0]].value
              : `host_${a[0]}`;

          const args = [];

          for (
            let i = 0;
            i < a[1];
            i++
          ) {
            args.unshift(
              bpop()
            );
          }

          bpush(
            hostCall(
              hostName,
              args
            )
          );

          break;
        }

        case 'CALL': {
          const args = [];

          for (
            let i = 0;
            i < a[1];
            i++
          ) {
            args.unshift(
              bpop()
            );
          }

          const target =
            image.functions[a[0]];

          const name =
            target
              ? sanitizeIdentifier(
                  target.name
                )
              : `fn_${a[0]}`;

          bpush(
            callExpr(
              variable(name),
              args
            )
          );

          break;
        }

        case 'CALL_VALUE': {
          const args = [];

          for (
            let i = 0;
            i < a[0];
            i++
          ) {
            args.unshift(
              bpop()
            );
          }

          const fn =
            bpop();

          bpush(
            callExpr(fn, args)
          );

          break;
        }

        case 'CLOSURE': {
          const target =
            image.functions[a[0]];

          bpush(
            variable(
              target
                ? sanitizeIdentifier(target.name)
                : `fn_${a[0]}`
            )
          );

          break;
        }

        case 'LOAD_UP': {
          bpush(
            variable(
              `upvalue_${a[0]}`
            )
          );

          break;
        }

        case 'STORE_UP': {
          const value =
            bpop();

          out.push(
            `upvalue_${a[0]} = ${value.code};`
          );

          break;
        }

        case 'LOAD_UPVALUE':
          bpush(
            variable(
              `upvalue_${a[0]}`
            )
          );
          break;

        case 'STORE_UPVALUE': {
          const value =
            bpop();

          out.push(
            `upvalue_${a[0]} = ${value.code};`
          );

          break;
        }

        case 'LOAD_THIS':
          bpush(
            variable('this')
          );
          break;

        case 'RET': {
          const value =
            bpop();

          out.push(
            `return ${value.code};`
          );

          break;
        }

        case 'JMP':
          out.push(
            `// VM jump -> ${a[0]}`
          );
          break;

        case 'JZ': {
          const condition =
            bpop();

          out.push(
            `// if (!(${condition.code})) goto ${a[0]}`
          );

          break;
        }

        case 'JNZ': {
          const condition =
            bpop();

          out.push(
            `// if (${condition.code}) goto ${a[0]}`
          );

          break;
        }

        case 'TRY':
          out.push(
            `// VM try handler -> ${a[0]}`
          );
          break;

        case 'END_TRY':
          out.push(
            '// end VM try'
          );
          break;

        case 'THROW': {
          const value =
            bpop();

          out.push(
            `throw ${value.code};`
          );

          break;
        }

        case 'AWAIT': {
          const value =
            bpop();

          bpush(
            new Expr(
              `await ${value.code}`
            )
          );

          break;
        }

        case 'NEW': {
          const args = [];

          for (
            let i = 0;
            i < a[0];
            i++
          ) {
            args.unshift(
              bpop()
            );
          }

          const ctor =
            bpop();

          bpush(
            new Expr(
              `new ${ctor.code}(${args.map(x => x.code).join(', ')})`
            )
          );

          break;
        }

        case 'NEW_VALUE': {
          const args = [];

          for (
            let i = 0;
            i < a[0];
            i++
          ) {
            args.unshift(
              bpop()
            );
          }

          const ctor =
            bpop();

          bpush(
            new Expr(
              `new ${ctor.code}(${args.map(x => x.code).join(', ')})`
            )
          );

          break;
        }

        case 'HALT':
          out.push(
            '// HALT'
          );
          break;

        default:
          out.push(
            `// unsupported VM instruction: ${n}`
          );
          break;
      }
    }

    blockOutput.set(
      block.id,
      out
    );
  }

  // --------------------------------------------------------------------------
  // Render function
  //
  // We deliberately emit explicit labels/gotos for control flow that cannot
  // be safely structured. JavaScript does not have goto, so use labeled blocks
  // and comments rather than generating invalid source.
  // --------------------------------------------------------------------------

  const name =
    sanitizeIdentifier(
      fn.name || `fn_${fn.index}`
    );

  const params = [];

  for (
    let i = 0;
    i < fn.params;
    i++
  ) {
    params.push(
      localName(i)
    );
  }

  const functionLines = [];

  functionLines.push(
    `function ${name}(${params.join(', ')}) {`
  );

  for (const block of blocks) {
    functionLines.push(
      `    // VM block ${block.id} @ ${block.start}`
    );

    const content =
      blockOutput.get(block.id) || [];

    for (const line of content)
      functionLines.push(
        `    ${line}`
      );

    const last =
      block.instructions[
        block.instructions.length - 1
      ];

    if (last) {
      if (
        last.name === 'JMP'
      ) {
        functionLines.push(
          `    // goto VM_${last.args[0]}`
        );
      }

      if (
        last.name === 'JZ'
      ) {
        functionLines.push(
          `    // conditional jump -> VM_${last.args[0]}`
        );
      }

      if (
        last.name === 'JNZ'
      ) {
        functionLines.push(
          `    // conditional jump -> VM_${last.args[0]}`
        );
      }
    }
  }

  functionLines.push('}');

  return functionLines.join('\n');
}

// ============================================================================
// FULL DECOMPILATION
// ============================================================================

function decompile(image) {
  const output = [];

  output.push(
    '// ================================================================'
  );

  output.push(
    '// Reconstructed from vm-gen bytecode'
  );

  output.push(
    '// Best-effort decompilation; not guaranteed to match original source'
  );

  output.push(
    '// ================================================================'
  );

  output.push(
    ''
  );

  output.push(
    "'use strict';"
  );

  output.push('');

  for (const fn of image.functions) {
    output.push(
      decompileFunction(
        fn,
        image
      )
    );

    output.push('');
  }

  if (image.functions.length) {
    const main =
      sanitizeIdentifier(
        image.functions[0].name ||
        'main'
      );

    output.push(
      `// Original VM entry point: ${main}()`
    );

    output.push(
      `// ${main}();`
    );
  }

  return output.join('\n');
}

// ============================================================================
// CLI
// ============================================================================

function usage() {
  console.log(`
VM-GEN JavaScript Decompiler

Usage:

  node vm-decompile.js protected.js
  node vm-decompile.js protected.js -o reconstructed.js
  node vm-decompile.js protected.js --json

Options:

  -o FILE       Write reconstructed source to FILE
  --json        Dump parsed VM structure instead
  --help        Show this help
`);
}

const args =
  process.argv.slice(2);

if (
  args.includes('--help') ||
  !args.length
) {
  usage();
  process.exit(0);
}

const input =
  args.find(
    x =>
      !x.startsWith('-')
  );

if (!input) {
  usage();
  process.exit(1);
}

if (!fs.existsSync(input)) {
  console.error(
    `File not found: ${input}`
  );
  process.exit(1);
}

let outputFile = null;

const oi =
  args.indexOf('-o');

if (
  oi !== -1 &&
  args[oi + 1]
) {
  outputFile =
    args[oi + 1];
}

try {
  const source =
    fs.readFileSync(
      input,
      'utf8'
    );

  console.error(
    '[+] Extracting VM image...'
  );

  const raw =
    extractImage(source);

  console.error(
    `[+] Image: ${raw.length} bytes`
  );

  console.error(
    '[+] Decrypting VM structures...'
  );

  const image =
    parseImage(raw);

  console.error(
    `[+] Constants: ${image.constants.length}`
  );

  console.error(
    `[+] Functions: ${image.functions.length}`
  );

  if (
    args.includes('--json')
  ) {
    const json = {
      constants:
        image.constants,

      functions:
        image.functions.map(
          fn => ({
            index: fn.index,
            name: fn.name,
            params: fn.params,
            locals: fn.locals,
            upvalues: fn.upvalues,
            protectionRounds:
              fn.rounds,

            instructions:
              decodeInstructions(
                fn,
                image
              )
          })
        )
    };

    console.log(
      JSON.stringify(
        json,
        null,
        2
      )
    );

    process.exit(0);
  }

  console.error(
    '[+] Reconstructing JavaScript...'
  );

  const reconstructed =
    decompile(image);

  if (outputFile) {
    fs.writeFileSync(
      outputFile,
      reconstructed
    );

    console.error(
      `[+] Wrote ${outputFile}`
    );
  } else {
    console.log(
      reconstructed
    );
  }

} catch (err) {
  console.error(
    `[!] ${err.message}`
  );

  if (process.env.DEBUG)
    console.error(
      err.stack
    );

  process.exit(1);
}
