'use strict';
// Example Prism config. The same object shape the API's build() accepts and the
// CLI flags mirror. Most fields below are honored in later phases; the shape is
// fixed now so config written today keeps working as capabilities land.
module.exports = {
  target: 'js',              // 'js' (now); 'lua', 'register' in Phase 5
  seed: 0xC0FFEE,            // deterministic: same source + seed + version => same bytes
  preset: 'balanced',        // named plugin+config bundle (Phase 3)

  // protection layers (Phase 3-4) -- declared now, wired progressively
  protect: {
    encStr: 'tree',          // string reconstruction scheme
    encNum: true,            // integer reconstruction
    flatten: true,           // control-flow flattening
    decoys: { count: 'auto' },
  },

  // per-region overrides via a match query (Phase 3)
  perRegion: [
    { match: 'fn:handlePayment', protect: { level: 3, flatten: true } },
  ],

  // third-party extensions (Phase 6 SDK) -- passes, backends, ciphers, ...
  plugins: [],
};
