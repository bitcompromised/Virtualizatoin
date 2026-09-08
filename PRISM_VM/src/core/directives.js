'use strict';
// Directive plugins: a customization point for the LANGUAGE itself. A directive
// plugin is `{ kind:'directive', name, expand(args, block) -> sourceString }`.
// Before parsing, Prism expands every `<@name ...>` (optionally followed by a
// `{ ... }` block) by calling the plugin, splicing its returned source in place.
// New surface syntax ships without touching the parser.

function matchBlock(src, from) {
  // src[from] must be '{'. Returns { inner, end } for the balanced block.
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { inner: src.slice(from + 1, i), end: i + 1 }; }
  }
  return null;
}

function findOne(src, byName) {
  let i = 0;
  while ((i = src.indexOf('<@', i)) !== -1) {
    const close = src.indexOf('>', i + 2);
    if (close === -1) break;
    const header = src.slice(i + 2, close).trim();
    const parts = header.split(/\s+/).filter(Boolean);
    const name = (parts[0] || '').toLowerCase();
    const plugin = byName[name];
    if (!plugin) { i = close + 1; continue; }
    const args = parts.slice(1);
    // optional trailing { block }
    let j = close + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    let block = null, end = close + 1;
    if (src[j] === '{') { const b = matchBlock(src, j); if (b) { block = b.inner; end = b.end; } }
    return { start: i, end, replacement: String(plugin.expand(args, block)) };
  }
  return null;
}

function expandDirectives(source, plugins) {
  const byName = {};
  for (const p of plugins) if (p && p.kind === 'directive') byName[p.name.toLowerCase()] = p;
  if (Object.keys(byName).length === 0) return source;
  let out = source;
  for (let guard = 0; guard < 10000; guard++) {
    const m = findOne(out, byName);
    if (!m) break;
    out = out.slice(0, m.start) + m.replacement + out.slice(m.end);
  }
  return out;
}

module.exports = { expandDirectives };
