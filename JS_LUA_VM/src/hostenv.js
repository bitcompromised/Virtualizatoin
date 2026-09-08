'use strict';
// Host environment shared by the reference interpreter (interp.js). It provides
// the runtime backing for the global environment and the JS-interop host
// builtins that the compiler emits: __getglobal / __setglobal (module-scope
// variables + host globals), typeof / bitnot / pow / instanceof / inop, a
// dynamic `require` bridge, and `__new` (construction of both VM classes and
// native constructors). The emitted standalone JS VM (emit-js.js) inlines an
// equivalent implementation so it stays dependency-free.

// Real host globals a program may reference by name. Everything here is standard
// and safe to expose; unknown names resolve to undefined.
function hostGlobalTable() {
  // CommonJS module/exports so top-level `module.exports = ...` has a real target.
  const mod = { exports: {} };
  return {
    module: mod, exports: mod.exports,
    undefined: undefined, NaN: NaN, Infinity: Infinity,
    globalThis, console,
    Object, Array, Math, JSON, Number, String, Boolean,
    Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    RegExp, Date, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    process: (typeof process !== 'undefined' ? process : undefined),
    Buffer: (typeof Buffer !== 'undefined' ? Buffer : undefined),
    setTimeout: (typeof setTimeout !== 'undefined' ? setTimeout : undefined),
  };
}

// Build a `require` bound to a base directory so relative specifiers resolve the
// way they would from the source file.
function makeRequire(baseDir) {
  const path = require('path');
  return function requireBridge(spec) {
    try {
      // Any relative specifier (including bare '.' / '..') resolves against the
      // source file's directory; bare package names go to normal resolution.
      if (spec && (/^\.\.?([\\/]|$)/.test(spec) || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec))) {
        return require(path.resolve(baseDir || process.cwd(), spec));
      }
      return require(spec);
    } catch (_) {
      try { return require(spec); } catch (__) { return undefined; }
    }
  };
}

module.exports = { hostGlobalTable, makeRequire };
