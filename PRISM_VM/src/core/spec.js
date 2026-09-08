'use strict';
// The opcode specification -- Prism's single source of truth.
//
// Each opcode's semantics are declared ONCE as `sem`: a small, PORTABLE micro-op
// tree (not a JS closure). A code generator (src/core/codegen.js) lowers `sem`
// to JavaScript AND to Lua, so a single definition drives every backend and
// every target language -- the JS interpreter, the standalone JS VM, and the
// standalone Lua VM all come from this table. Fix an opcode here and it is fixed
// everywhere, in step, by construction. This is the answer to vm-gen's three
// hand-written machines that drifted apart.
//
// Micro-op forms (arrays):
//   expressions: ['pop'] ['peek'] ['u16'] ['u8'] ['const',E] ['local',E]
//                ['lit',v] ['var',name] ['bin',op,A,B] ['neg',A] ['not',A]
//                ['truthy',A]      (op in + - * / % eq lt)
//   statements : ['let',name,E] ['push',E] ['do',E] ['setlocal',I,E]
//                ['setip',E] ['print',E] ['halt'] ['ret'] ['call',Fn,Ac]
//                ['if',Cond,[stmts]]
// Every value operation (add, eq, truthy, ...) is a facade call, so the same
// tree lowers to any host that provides the facade.

const V = ['var'];
const pop = ['pop'];
const bin2 = (op, l, r) => ['bin', op, l, r];
// helper: pop b, pop a, then push f(a,b)
const binop = (op, negate) => {
  const e = negate ? ['not', op] : op;
  return [['let', 'b', pop], ['let', 'a', pop], ['push', e]];
};

const OPS = [
  { name: 'HALT', operands: [], sem: [['halt']] },

  { name: 'PUSH_CONST', operands: ['u16'], sem: [['push', ['const', ['u16']]]] },
  { name: 'PUSH_TRUE', operands: [], sem: [['push', ['lit', true]]] },
  { name: 'PUSH_FALSE', operands: [], sem: [['push', ['lit', false]]] },
  { name: 'PUSH_NULL', operands: [], sem: [['push', ['lit', null]]] },
  { name: 'POP', operands: [], sem: [['do', pop]] },
  { name: 'DUP', operands: [], sem: [['push', ['peek']]] },

  { name: 'LOAD', operands: ['u16'], sem: [['push', ['local', ['u16']]]] },
  { name: 'STORE', operands: ['u16'], sem: [['setlocal', ['u16'], pop]] },

  { name: 'ADD', operands: [], sem: binop(bin2('+', ['var', 'a'], ['var', 'b'])) },
  { name: 'SUB', operands: [], sem: binop(bin2('-', ['var', 'a'], ['var', 'b'])) },
  { name: 'MUL', operands: [], sem: binop(bin2('*', ['var', 'a'], ['var', 'b'])) },
  { name: 'DIV', operands: [], sem: binop(bin2('/', ['var', 'a'], ['var', 'b'])) },
  { name: 'MOD', operands: [], sem: binop(bin2('%', ['var', 'a'], ['var', 'b'])) },
  { name: 'NEG', operands: [], sem: [['let', 'a', pop], ['push', ['neg', ['var', 'a']]]] },
  { name: 'NOT', operands: [], sem: [['let', 'a', pop], ['push', ['not', ['truthy', ['var', 'a']]]]] },

  { name: 'EQ', operands: [], sem: binop(bin2('eq', ['var', 'a'], ['var', 'b'])) },
  { name: 'NE', operands: [], sem: binop(bin2('eq', ['var', 'a'], ['var', 'b']), true) },
  { name: 'LT', operands: [], sem: binop(bin2('lt', ['var', 'a'], ['var', 'b'])) },
  { name: 'GT', operands: [], sem: binop(bin2('lt', ['var', 'b'], ['var', 'a'])) },
  { name: 'LE', operands: [], sem: binop(bin2('lt', ['var', 'b'], ['var', 'a']), true) },
  { name: 'GE', operands: [], sem: binop(bin2('lt', ['var', 'a'], ['var', 'b']), true) },

  { name: 'JMP', operands: ['u16'], sem: [['setip', ['u16']]] },
  { name: 'JZ', operands: ['u16'], sem: [['let', 't', ['u16']], ['let', 'v', pop], ['if', ['not', ['truthy', ['var', 'v']]], [['setip', ['var', 't']]]]] },
  { name: 'JNZ', operands: ['u16'], sem: [['let', 't', ['u16']], ['let', 'v', pop], ['if', ['truthy', ['var', 'v']], [['setip', ['var', 't']]]]] },

  { name: 'CALL', operands: ['u16', 'u8'], sem: [['let', 'f', ['u16']], ['let', 'c', ['u8']], ['call', ['var', 'f'], ['var', 'c']]] },
  { name: 'RET', operands: [], sem: [['ret']] },
  { name: 'PRINT', operands: [], sem: [['print', pop]] },

  // arrays (facade primitives newArray/indexGet/indexSet/len keep the value model
  // in the machine, where each backend/language implements it; the handlers below
  // are generated for every backend from this one `sem`).
  { name: 'NEW_ARRAY', operands: ['u16'], sem: [['push', ['fcall', 'newArray', [['u16']]]]] },
  { name: 'NEW_OBJECT', operands: ['u16'], sem: [['push', ['fcall', 'newObject', [['u16']]]]] },
  { name: 'INDEX_GET', operands: [], sem: [['let', 'i', pop], ['let', 'a', pop], ['push', ['fcall', 'indexGet', [['var', 'a'], ['var', 'i']]]]] },
  { name: 'INDEX_SET', operands: [], sem: [['let', 'v', pop], ['let', 'i', pop], ['let', 'a', pop], ['do', ['fcall', 'indexSet', [['var', 'a'], ['var', 'i'], ['var', 'v']]]]] },
  { name: 'LEN', operands: [], sem: [['let', 'a', pop], ['push', ['fcall', 'len', [['var', 'a']]]]] },
  // host bridge: CALL_HOST <nameConstIdx> <argc> -> push host(name, args)
  { name: 'CALL_HOST', operands: ['u16', 'u8'], sem: [['let', 'n', ['const', ['u16']]], ['let', 'c', ['u8']], ['push', ['fcall', 'host', [['var', 'n'], ['var', 'c']]]]] },

  // closures: capture cells / call a closure value / access upvalues
  { name: 'CLOSURE', operands: ['u16'], sem: [['push', ['fcall', 'makeClosure', [['u16']]]]] },
  { name: 'CALL_VALUE', operands: ['u8'], sem: [['let', 'c', ['u8']], ['do', ['fcall', 'callValue', [['var', 'c']]]]] },
  { name: 'LOAD_UPVAL', operands: ['u16'], sem: [['push', ['fcall', 'getUpval', [['u16']]]]] },
  { name: 'STORE_UPVAL', operands: ['u16'], sem: [['let', 'i', ['u16']], ['let', 'v', pop], ['do', ['fcall', 'setUpval', [['var', 'i'], ['var', 'v']]]]] },
];

const OP = {};
const OP_NAME = [];
OPS.forEach((o, i) => { o.id = i; OP[o.name] = i; OP_NAME[i] = o.name; });

function opWidth(id) {
  let n = 1;
  for (const k of OPS[id].operands) n += k === 'u16' ? 2 : 1;
  return n;
}

// Extension point: append a new opcode to the ISA. Every backend regenerates its
// handler from `sem` automatically (they iterate OPS), so one call teaches the
// interpreter, the JS VMs and the Lua VM a new instruction in lock-step. Returns
// the assigned id. (Process-global for now; build-scoped ISAs are a later
// refinement -- noted, not hidden.)
function registerOpcode(def) {
  if (!def || !def.name || !Array.isArray(def.sem)) throw new Error('opcode needs { name, operands, sem }');
  if (OP[def.name] !== undefined) return OP[def.name];
  const o = { name: def.name, operands: def.operands || [], sem: def.sem, id: OPS.length };
  OPS.push(o); OP[o.name] = o.id; OP_NAME[o.id] = o.name;
  return o.id;
}

module.exports = { OPS, OP, OP_NAME, opWidth, byId: OPS, registerOpcode };
