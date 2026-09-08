'use strict';
// Central version + bytecode-format definitions.
//
// The image header is formalized so that future VM generations can coexist and
// be told apart without guessing:
//
//   byte  0..1  magic 'V' 'G'
//   byte  2     format major   (incompatible format changes bump this)
//   byte  3     format minor   (backward-compatible additions bump this)
//   byte  4     flags          (bitfield; see FLAG_*)
//   byte  5     profile        (see PROFILES)
//   byte  6     architecture   (see ARCH)
//   byte  7..10 u32 checksum   (FNV-1a over the header-meta bytes 2..6 + body)
//   byte 11..   body
//
// A decoder validates magic + major before trusting anything else. The four
// independent version numbers below let a host reason about compatibility of the
// compiler, the VM ABI, the bytecode, and the protection scheme separately.

module.exports = {
  MAGIC0: 0x56, // 'V'
  MAGIC1: 0x47, // 'G'

  // On-disk image format. Bump MAJOR only for incompatible layout changes.
  FORMAT_MAJOR: 2,
  FORMAT_MINOR: 0,

  // Independent, separately-evolving component versions (reported by the CLI and
  // available to hosts for compatibility checks / negotiation).
  COMPILER_VERSION: '0.2.0', // source language + codegen
  VM_ABI_VERSION: 2,         // host interface / runtime contract
  BYTECODE_VERSION: 2,       // opcode table + instruction encoding
  PROTECTION_VERSION: 2,     // permutation / cipher / integrity scheme

  // Header flag bits (byte 4).
  FLAG_OPTIMIZED: 0x01, // compile-time optimizer was applied
  FLAG_LIMITED: 0x02,   // runtime resource limits are enforced
  FLAG_SIGNED: 0x04,    // artifact carries a keyed MAC verified at runtime
  FLAG_IDENTPERM: 0x08, // opcode permutation is identity (development builds)
  FLAG_DERIVED: 0x10,   // seeds + permutation are derived from a hidden master seed (not stored)

  // Build profiles (header byte 5).
  PROFILES: { development: 0, balanced: 1, aggressive: 2, performance: 3 },
  PROFILE_NAMES: ['development', 'balanced', 'aggressive', 'performance'],

  // VM architecture (header byte 6). Only the stack/switch VM exists today;
  // the field reserves space so register / threaded / block VMs can coexist.
  ARCH: { 'stack-switch': 0, 'register-threaded': 1, 'register-indirect': 2, 'stack-block': 3, 'register': 4, 'register-encrypted': 5 },
  ARCH_NAMES: ['stack-switch', 'register-threaded', 'register-indirect', 'stack-block', 'register', 'register-encrypted'],
};

// Per-profile build configuration. `optimize` and `permute` shape the artifact;
// `maxSteps` / `maxDepth` are runtime resource limits embedded into the VM
// (0 = unlimited). These are defaults; explicit CLI flags override them.
// `maxObjects` caps live object/array allocations; `maxString` caps the length
// of any single string produced by concatenation. Both 0 = unlimited.
// Global protection floor applied to every function (per-function directives win
// on top). `flatten` = control-flow flattening; `bogus` = bogus-CF intensity
// (0..3); `split` = basic-block splitting; `protLevel` = cipher rounds per
// function (0..3); `encStr` = string-literal reconstruction (none|str_arr|hex|
// bytecode|random); `fuse` = superinstruction fusion.
module.exports.PROFILE_CONFIG = {
  development:  { optimize: false, permute: false, conceal: false, dud: false, fuse: false, flatten: false, bogus: 0, split: false, protLevel: 0, encStr: 'none',  encNum: false, maxSteps: 0,         maxDepth: 0,    maxObjects: 0,       maxString: 0,        arch: 'stack-switch' },
  balanced:     { optimize: true,  permute: true,  conceal: false, dud: false, fuse: false, flatten: false, bogus: 0, split: false, protLevel: 1, encStr: 'none',  encNum: false, maxSteps: 0,         maxDepth: 1024, maxObjects: 0,       maxString: 0,        arch: 'stack-switch' },
  aggressive:   { optimize: true,  permute: true,  conceal: true,  dud: true,  fuse: true,  flatten: true,  bogus: 2, split: true,  protLevel: 2, encStr: 'random', encNum: true,  maxSteps: 200000000, maxDepth: 512,  maxObjects: 5000000, maxString: 33554432, arch: 'stack-switch' },
  performance:  { optimize: true,  permute: true,  conceal: false, dud: false, fuse: false, flatten: false, bogus: 0, split: false, protLevel: 1, encStr: 'none',  encNum: false, maxSteps: 0,         maxDepth: 0,    maxObjects: 0,       maxString: 0,        arch: 'stack-switch' },
};
