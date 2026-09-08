'use strict';
// Backend registry -- the `kind:'backend'` extension point, consumed. A backend
// plugin is `{ kind:'backend', name, target?, machine?, emit(image, opts) -> code }`.
// The four built-ins below register through the exact same shape a third party
// would, so "add a new target language/machine" is a plugin, not a core edit.
//
// Resolution order for a (target, machine): a custom backend from `opts.plugins`
// wins (matched by `name === target`, else by `target`/`machine`), then the
// built-ins. This is what lets `build(src, { target:'wasm', plugins:[wasmBackend] })`
// -- or an inline `<@protect backend=wasm>` -- reach a third-party backend.

const { emitJs } = require('./emit-js');
const { emitJsReg } = require('./emit-js-reg');
const { emitLua } = require('./emit-lua');
const { emitPy } = require('./emit-py');
const { definePlugin } = require('../core/plugin');

const BUILTINS = [
  definePlugin({ kind: 'backend', name: 'js', target: 'js', machine: 'stack', emit: emitJs }),
  definePlugin({ kind: 'backend', name: 'js-reg', target: 'js', machine: 'register', emit: emitJsReg }),
  definePlugin({ kind: 'backend', name: 'lua', target: 'lua', emit: emitLua }),
  definePlugin({ kind: 'backend', name: 'py', target: 'py', emit: emitPy }),
];

function backendsFrom(plugins) {
  return (Array.isArray(plugins) ? plugins.filter((p) => p && p.kind === 'backend') : []);
}

// Resolve a backend plugin for (target, machine), custom plugins first.
function resolveBackend(target, machine, opts = {}) {
  const custom = backendsFrom(opts.plugins);
  const match = (list) => list.find((b) => b.name === target)
    || list.find((b) => (b.target || b.name) === target && (b.machine ? b.machine === machine : true));
  const chosen = match(custom)
    || (target === 'js' && machine === 'register' ? BUILTINS.find((b) => b.name === 'js-reg') : null)
    || match(BUILTINS);
  if (!chosen) {
    const known = BUILTINS.map((b) => b.name).join(' | ');
    throw new Error(`Prism: no backend for target '${target}'${machine ? "/" + machine : ''} (built-ins: ${known}; register a kind:'backend' plugin to add one)`);
  }
  return chosen;
}

module.exports = { BUILTINS, resolveBackend, backendsFrom };
