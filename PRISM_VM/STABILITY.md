# Prism — API stability (contract v1)

Prism's public surface is versioned so extensions written today keep working. This is the
customization/upgradeability promise: **you extend Prism through the SDK, never by patching core.**

## Stability tiers

| Tier | Meaning | Change policy |
|---|---|---|
| **stable** | Frozen at API v1. | No breaking change without a major bump + a migration note. |
| **evolving** | Shape is committed; fields may be *added*. | Additive only within a major. |
| **experimental** | May change. | Guarded; announced in the changelog. |

## The surface

### Programmatic API — `require('@prism/core')`  · *stable*
- `run(source, opts) -> { output, steps }`
- `build(source, opts) -> { code, image, meta }`
- `analyze(source) -> { functions: [{ name, params, locals }] }`
- `toImage(source, opts) -> image`

`opts` (all optional): `target` (`js` | `lua` | `py`), `machine` (`stack` | `register`), `encrypted`,
`seed`, `optimize`, `protect:{ bogus, decoys, decoyStrength, sign, cipher, integrity }`, `encryptConsts`,
`plugins:[...]`. Same source + seed + version ⇒ byte-identical artifact.

### Inline protection — `<@protect …>`  · *stable*
A program can request its own protection in source, so a build is reproducible from the file alone:

```
<@protect encrypt permute sign decoys=3 bogus=2 backend=py>
```

Recognized: `encrypt`/`no-encrypt`, `permute`, `sign`, `encrypted`, `optimize`/`no-optimize`,
`decoys=N`, `strength=N`, `bogus=N`, `seed=N`, `cipher=none|xor|…`, `integrity=fnv1a|fnv1a-mac|…`,
`backend=js|lua|py|…`, `machine=stack|register`. Explicit build options override the pragma; an unknown
token throws so a typo fails loudly.

### Plugin SDK — `require('@prism/core').sdk`  · *evolving*
- `definePlugin({ kind, name, ... })` — freeze a plugin descriptor.
- `registerOpcode({ name, operands, sem })` — extend the ISA; every backend regenerates from `sem`.
- `expandDirectives(source, plugins)` — the directive pre-pass (used internally by `compile`).
- `testPlugin(plugins, cases, opts) -> { passed, failed, results }` — verify a plugin against the
  in-process oracle (interpreter ≡ register machine ≡ standalone JS VM ≡ expected), no external runtime
  required. Use this in your plugin's tests; the full gate (`test/conformance.js`) additionally runs the
  Lua and Python VMs.

### Extension points (a plugin's `kind`)
| kind | wired | contract |
|---|---|---|
| `pass` | ✅ | `{ stage:'optimize'\|'obfuscate'\|'lower', run(fn, ctx) }` — IR→IR over `fn.instrs` |
| `directive` | ✅ | `{ name, expand(args, block) -> sourceString }` — new surface syntax |
| `opcode` | ✅ | `{ name, operands, sem }` via `registerOpcode` — new instruction, all backends |
| `decoy` | ✅ | `{ generate(fn, ctx) }` — emit an unreferenced function; `protect:{ decoys:N }` |
| `cipher` | ✅ | `{ id≥16, encode(blob,seed), decode(blob,seed) }` — const-pool cipher; `protect:{ cipher:name }` |
| `integrity` | ✅ | `{ id≥16, signed?, digest(bytes,signKey) }` — image checksum/MAC; `protect:{ integrity:name }` / `sign` |
| `backend` | ✅ | `{ target, machine?, emit(image,opts) }` — a new codegen target; `target:name` |

A third-party `cipher`/`integrity` (`id ≥ 16`) has its pure `decode`/`digest` **embedded** into the JS
artifact, so the standalone VM stays self-contained. Built-in ids (`< 16`) are inlined in the decoder.

`fn.instrs` uses **label-marker** jump targets, so a pass may splice instructions freely; offsets are
resolved once at the end. `ctx = { rng, constId, consts, OP, OPS, opWidth }`.

## Guarantees
- **Determinism** — reproducible from source + seed + version.
- **Safety by oracle** — a pass/opcode/decoy that breaks behavior is caught by differential conformance
  across the interpreter, the JS VMs, the Lua VM, and the Python VM; obfuscation is safe *by construction*.
- **Additive image format** — a decoder for format vN reads and migrates vN−1 (see `src/core/image.js`).
