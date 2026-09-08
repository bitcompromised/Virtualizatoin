'use strict';
// Disassembler: image -> human-readable bytecode listing. Uses the spec's operand
// widths (no hand-kept table), so it stays correct as the ISA grows.
const { OP_NAME, OPS } = require('./spec');

function disassemble(image) {
  const L = [];
  L.push('; consts: ' + image.consts.map((c, i) => i + '=' + (typeof c === 'string' ? JSON.stringify(c) : c)).join('  '));
  image.functions.forEach((fn, fi) => {
    L.push(`\nfn #${fi} ${fn.name ? '(' + fn.name + ') ' : ''}nparams=${fn.nparams} nlocals=${fn.nlocals}:`);
    let p = 0;
    while (p < fn.code.length) {
      const op = fn.code[p];
      const name = OP_NAME[op] || ('??' + op);
      const kinds = OPS[op] ? OPS[op].operands : [];
      const args = []; let q = p + 1;
      for (const kind of kinds) {
        if (kind === 'u16') { args.push(fn.code[q] | (fn.code[q + 1] << 8)); q += 2; } else { args.push(fn.code[q]); q += 1; }
      }
      L.push('  ' + String(p).padStart(4) + '  ' + name + (args.length ? '  ' + args.join(', ') : ''));
      p = q;
    }
  });
  return L.join('\n');
}

module.exports = { disassemble };
