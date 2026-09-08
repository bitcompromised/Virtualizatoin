'use strict';
// Backend: in-process interpreter (the oracle). Its opcode handlers are GENERATED
// from the spec's portable `sem` -- no semantics are written here. Same source
// the JS and Lua emitters lower; the interpreter just compiles them to JS
// functions once.
const { execProgram } = require('../core/machine');
const { OPS } = require('../core/spec');
const { jsBody } = require('../core/codegen');

// Compile each opcode's sem -> a JS handler(F). Cached, but rebuilt if the ISA
// grew (a plugin registered a new opcode), so extensions are picked up.
let _cache = null, _len = -1;
function handlers() {
  if (_len !== OPS.length) { _cache = OPS.map((o) => new Function('F', jsBody(o.sem))); _len = OPS.length; } // eslint-disable-line no-new-func
  return _cache;
}

function interpret(image, opts = {}) {
  return execProgram(image, handlers(), opts);
}

module.exports = { interpret };
