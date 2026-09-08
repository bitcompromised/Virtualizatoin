'use strict';
// Seedable, deterministic PRNG (LCG). Same seed -> same stream, so builds are
// reproducible -- a core Prism guarantee (source + seed + version => same bytes).
function makeRng(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  return function next() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}
module.exports = { makeRng };
