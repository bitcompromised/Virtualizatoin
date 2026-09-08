'use strict';
// Public programmatic API for vm-gen.
//
//   const { generate, compile, disassemble, interpret } = require('vm-gen');
//   const { output } = generate('print 1 + 1;', { target: 'lua', profile: 'aggressive' });
//
const { generate, compile, buildImage, disassemble, resolveConfig } = require('./src/generate');
const { emitJs } = require('./src/emit-js');
const { emitLua } = require('./src/emit-lua');
const { interpret } = require('./src/interp');
const { optimize } = require('./src/optimize');
const { benchmark } = require('./src/benchmark');
const opcodes = require('./src/opcodes');
const version = require('./src/version');

module.exports = {
  generate, compile, buildImage, disassemble, resolveConfig,
  emitJs, emitLua, interpret, optimize, benchmark,
  opcodes, version,
};

console.log(module.exports.opcodes.OPCODES);
