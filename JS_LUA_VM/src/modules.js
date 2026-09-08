'use strict';
// Optional modules / imports.
//
//   import "lib.vgs";
//
// A top-level `import "path";` line is replaced, before lexing, with the
// (recursively expanded) contents of the named module. Each module is included
// at most once, so diamond and cyclic import graphs terminate and never double-
// define. Resolution is delegated to a caller-provided `resolve(path)` function
// (the CLI reads files relative to the importing file's directory); when no
// resolver is supplied, a program that uses `import` is rejected with a clear
// error instead of silently dropping code.

const IMPORT_RE = /^[ \t]*import[ \t]+["']([^"']+)["'][ \t]*;?[ \t]*$/gm;

function expandImports(source, resolve, seen) {
  seen = seen || new Set();
  return source.replace(IMPORT_RE, (_m, path) => {
    if (seen.has(path)) return ''; // already included -- breaks cycles/diamonds
    seen.add(path);
    if (typeof resolve !== 'function') {
      throw new Error(`import "${path}" requires a module resolver`);
    }
    const imported = resolve(path);
    if (imported == null) throw new Error(`cannot resolve import "${path}"`);
    return expandImports(imported, resolve, seen);
  });
}

// True if the source contains at least one top-level import.
function hasImports(source) {
  IMPORT_RE.lastIndex = 0;
  return IMPORT_RE.test(source);
}

module.exports = { expandImports, hasImports };
