'use strict';
// Extension model. Everything customizable in Prism is a plugin registered here
// against a stable extension point. The built-in passes/backends will use the
// exact same API third parties do -- nothing in core is privileged.
//
// kinds (extension points): 'pass' | 'backend' | 'directive' | 'cipher'
//                         | 'integrity' | 'decoy' | 'opcode'
//
// This is the SDK seam for Phases 3-6 of the plan; the registry is live now so
// the architecture is real from the first commit. ALL seven kinds are consumed:
// 'pass', 'directive', 'opcode', and 'decoy' verified against the oracle; 'backend'
// resolves the codegen target; 'cipher' and 'integrity' drive the image's
// constant-pool cipher and checksum/MAC (a third-party algorithm is embedded into
// the standalone artifact). The SDK's testPlugin harness exercises them end-to-end.

function definePlugin(def) {
  if (!def || !def.kind || !def.name) throw new Error('plugin needs { kind, name }');
  return Object.freeze(Object.assign({}, def));
}

function createRegistry() {
  const byKind = new Map();
  return {
    register(plugin) {
      const p = definePlugin(plugin);
      if (!byKind.has(p.kind)) byKind.set(p.kind, new Map());
      byKind.get(p.kind).set(p.name, p);
      return p;
    },
    get(kind, name) { return byKind.has(kind) ? byKind.get(kind).get(name) : undefined; },
    all(kind) { return byKind.has(kind) ? [...byKind.get(kind).values()] : []; },
    kinds() { return [...byKind.keys()]; },
  };
}

module.exports = { definePlugin, createRegistry };
