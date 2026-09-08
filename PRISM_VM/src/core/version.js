'use strict';
// Version + capability surface. Everything an artifact encodes on disk is
// versioned from day one so a future decoder can read and migrate older images.
module.exports = {
  PRISM_VERSION: '0.1.0',
  IMAGE_FORMAT: 1,          // bump on incompatible image layout changes
  BYTECODE_VERSION: 1,      // opcode table / encoding
  API_VERSION: 1,           // programmatic API + plugin SDK contract (see STABILITY.md)
  // Capability flags negotiated between an artifact and a host/backend.
  CAP: { STRINGS: 1, FUNCTIONS: 2, FLOAT: 4 },
};
