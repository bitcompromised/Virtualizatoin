'use strict';
// Canonical opcode table. These ids are STABLE and language-agnostic.
// A per-build random permutation maps each canonical id to the byte that is
// actually emitted into the bytecode (see protect.js). The generated VM is
// built with the inverse permutation, so no two builds share the same opcode
// encoding -- a "moving target" defense against pattern-based disassembly.
//
// The `operands` field describes the operand layout for each instruction so
// that the assembler, the disassembler and both VM back-ends stay in sync.
//   u16  -> unsigned 16-bit, little-endian
//   u8   -> unsigned 8-bit
//   (none) -> no operands
//
// Keep this list append-only; reordering would change the canonical ids.

const OPCODES = [
  // name            operands
  ['HALT',           []],
  ['PUSH_CONST',     ['u16']],   // push consts[idx]
  ['PUSH_TRUE',      []],
  ['PUSH_FALSE',     []],
  ['PUSH_NULL',      []],
  ['POP',            []],
  ['DUP',            []],
  ['LOAD',           ['u16']],   // push locals[slot]
  ['STORE',          ['u16']],   // locals[slot] = pop()
  ['ADD',            []],
  ['SUB',            []],
  ['MUL',            []],
  ['DIV',            []],
  ['MOD',            []],
  ['NEG',            []],
  ['NOT',            []],
  ['EQ',             []],
  ['NEQ',            []],
  ['LT',             []],
  ['GT',             []],
  ['LTE',            []],
  ['GTE',            []],
  ['BAND',           []],
  ['BOR',            []],
  ['BXOR',           []],
  ['SHL',            []],
  ['SHR',            []],
  ['JMP',            ['u16']],   // ip = addr
  ['JZ',             ['u16']],   // if !pop() ip = addr
  ['JNZ',            ['u16']],   // if pop() ip = addr
  ['CALL',           ['u16', 'u8']], // call function fnIdx with argc args
  ['RET',            []],
  ['CALL_HOST',      ['u16', 'u8']], // call host builtin named consts[idx]
  ['NEW_ARR',        ['u16']],   // pop N values -> array
  ['ARR_GET',        []],        // arr[idx]  (also obj[key])
  ['ARR_SET',        []],        // arr[idx] = val  (also obj[key] = val; leaves val)
  ['PRINT',          []],        // host print pop()
  // ---- objects / maps (append-only; keeps canonical ids stable) ----
  ['NEW_OBJ',        ['u16']],   // pop N (key,value) pairs -> object
  // ---- first-class functions / closures ----
  ['CLOSURE',        ['u16']],   // build a closure over functions[idx], capturing upvalues
  ['LOAD_UP',        ['u16']],   // push upvalue[slot]
  ['STORE_UP',       ['u16']],   // upvalue[slot] = pop()
  ['LOAD_UPVALUE',   ['u16']],   // push upvalue by name (consts[idx]) => cell.v
  ['STORE_UPVALUE',  ['u16']],   // upvalue by name (consts[idx]) = pop()
  ['CLOSE_UPVALUE',  ['u16']],   // ensure local slot is closed into a heap cell
  ['CALL_VALUE',     ['u8']],    // call a closure value with argc args (callee below args)
  // ---- method / this support ----
  ['LOAD_THIS',      []],        // push current frame's this binding
  ['LOAD_ARGS',      []],        // push current frame's arguments array (varargs)
  ['YIELD',          []],        // generator: append top-of-stack to the frame's yield list
  ['CALL_METHOD',    ['u8']],    // call a method with receiver below callee and argc args
  ['NEW',            ['u16','u8']], // new fnIdx argc -> alloc instance, set proto, call ctor
  ['NEW_VALUE',      ['u8']],    // new <value>(argc) -> callee is value on stack
  // ---- exceptions ----
  ['TRY',            ['u16']],   // install a catch handler at addr
  ['END_TRY',        []],        // remove the top catch handler
  ['THROW',          []],        // throw pop()
  // ---- superinstructions (instruction-set polymorphism) ----
  // Each fuses a common (load/const, op) pair. Per build their emitted bytes are
  // randomized like every other opcode, so the fused forms differ each build.
  ['LOADADD',        ['u16']],   // = LOAD slot ; ADD
  ['LOADSUB',        ['u16']],   // = LOAD slot ; SUB
  ['LOADLT',         ['u16']],   // = LOAD slot ; LT
  ['CONSTADD',       ['u16']],   // = PUSH_CONST idx ; ADD
  ['AWAIT',          []],
];

const OP = {};
OPCODES.forEach(([name], i) => { OP[name] = i; });

const OP_NAME = OPCODES.map(([name]) => name);
const OP_OPERANDS = OPCODES.map(([, ops]) => ops);

module.exports = { OPCODES, OP, OP_NAME, OP_OPERANDS };
