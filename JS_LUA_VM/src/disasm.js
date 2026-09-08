'use strict';
// Canonical disassembler -- prints the compiled program BEFORE protection.
// Useful for debugging the compiler and for understanding what the protected
// image contains.

const { OP_NAME, OP_OPERANDS } = require('./opcodes');

function disassemble(program) {
  const lines = [];
  lines.push(`; consts: ${program.consts.map((c, i) => `${i}=${JSON.stringify(c)}`).join('  ')}`);
  program.functions.forEach((fn, idx) => {
    lines.push(`\nfunction #${idx} ${fn.name}(params=${fn.nparams}, locals=${fn.nlocals}):`);
    let off = 0;
    for (const ins of fn.instrs) {
      const name = OP_NAME[ins.op];
      const kinds = OP_OPERANDS[ins.op];
      const args = ins.args.slice(0, kinds.length).join(', ');
      lines.push(`  ${String(off).padStart(4, '0')}  ${name}${args ? ' ' + args : ''}`);
      off += 1 + kinds.reduce((a, k) => a + (k === 'u16' ? 2 : 1), 0);
    }
  });
  return lines.join('\n');
}

module.exports = { disassemble };
