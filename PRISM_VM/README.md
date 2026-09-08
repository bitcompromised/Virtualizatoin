# Prism

**One spec, many machines.** Prism is a spec-driven, plugin-based bytecode-virtualization
obfuscator for a JavaScript subset — the successor to `vm-gen`, rebuilt so the VM's semantics
live in **one** declarative opcode spec that generates every backend, and so every transform,
backend, and directive is a plugin against a stable, versioned API.

> Status: **Phases 0–6 landing.** Green and end-to-end. One **portable** opcode spec now generates
> **five** machines — the JS interpreter, a standalone JS VM (stack), a standalone JS VM on a
> **register machine** (optionally with an encrypted stack pointer), a standalone **Lua VM**, **and a
> standalone Python VM** — proving "one spec, many machines" across two machine *models* and **three
> target languages** (JS, Lua, Python), with no hand-written, drift-prone semantics anywhere. A
> plugin-based pass scheduler runs optimization **and** obfuscation, artifacts can be padded with
> unreachable **decoy functions**, and JS artifacts ship a **versioned binary image** with an
> **integrity domain**, a **constant-pool cipher**, and **per-build opcode permutation** — stackable
> with an **encrypted register machine**. A **plugin SDK** (frozen at **API v1**, see
> [STABILITY.md](STABILITY.md)) lets a third party add a pass, a language directive, a **decoy**, or
> even a **new opcode** without touching core, and self-verify against the multi-backend oracle. The
> language runs real programs — arrays, objects, closures & higher-order functions, `for`, `Math`/host
> builtins, a bubble sort. Differential conformance **and a fuzzer** gate everything — every machine,
> every program, every extension (`321 + 9 passed, 0 failed`; fuzzer 3000 inputs clean).

## The keystone

Each opcode is declared **once** in [`src/core/spec.js`](src/core/spec.js) as a **portable** `sem`
micro-op tree — not a JS closure. A single [code generator](src/core/codegen.js) lowers `sem` to
JavaScript **and** to Lua, so every backend and every target language comes from one definition:

- [`backends/interp.js`](src/backends/interp.js) — the in-process interpreter (the **oracle**); handlers compiled from `sem`.
- [`backends/emit-js.js`](src/backends/emit-js.js) — a standalone, dependency-free JS VM (stack model).
- [`backends/emit-js-reg.js`](src/backends/emit-js-reg.js) — a standalone JS VM on a **register machine** (optionally with an encrypted stack pointer).
- [`backends/emit-lua.js`](src/backends/emit-lua.js) — a standalone **Lua** VM, generated from the *same* `sem`.
- [`backends/emit-py.js`](src/backends/emit-py.js) — a standalone **Python** VM, generated from the *same* `sem`.

Because all five come from one definition, "the backends disagree" — the bug class that dogged
vm-gen's three hand-written machines — is designed out. Fix an opcode once, and it is fixed in every
backend, across both machine models and all three languages, at the same time. The
[conformance gate](test/conformance.js) asserts `interpreter ≡ emitted ≡ expected` on every program —
including every program rebuilt with obfuscation, padded with decoys, run on the **Lua** and
**Python** backends, and a custom third-party pass:

```
321 passed, 0 failed
```

## The pass pipeline

Optimization and obfuscation are the same thing — an IR→IR transform over a function's instruction
list — so they share one scheduler ([`src/core/passes.js`](src/core/passes.js)) ordered by stage
(`optimize` → `obfuscate` → `lower`). Every pass is a `kind:'pass'` plugin; the built-ins use the
same API a third party would:

- `peephole-clean` (optimize) — removes dead `[pure-push][POP]` pairs.
- `bogus-stack` (obfuscate) — inserts net-zero churn; density scales 1–3.

The IR uses **label-marker** jump targets, so a pass can splice instructions freely without breaking
control flow. A custom pass is just `definePlugin({ kind:'pass', stage, run(fn, ctx) })` passed in
`build(src, { plugins: [myPass] })`. Obfuscation is safe *by construction* — the conformance gate
proves every pass preserves behavior on both backends.

```bash
node src/cli.js build examples/fib.js --bogus 2   # optimize, then obfuscate
```

## Plugin SDK (`src/sdk.js`, API v1)

Everything customizable is a plugin registered against a stable extension point — the built-ins use
the same API third parties do. **All seven kinds are wired**:

- **`pass`** — an IR→IR transform (optimization or obfuscation).
- **`directive`** — a language macro: `<@name args> { block }` expands to source before parsing.
- **`opcode`** — `registerOpcode({ name, operands, sem })` extends the ISA; **every backend
  regenerates its handler from `sem`**, so the interpreter, JS VMs, Lua VM, and Python VM gain the
  instruction in lock-step.
- **`decoy`** — `{ generate(fn, ctx) }` emits an **unreferenced** function into the image; enabled with
  `protect:{ decoys:N }`. Because no real instruction targets a decoy, it is output-neutral by
  construction — the oracle proves it on every backend.
- **`backend`** — `{ target, machine?, emit(image, opts) }` adds a codegen target, selected by
  `target:` (the four built-in machines register through this exact shape).
- **`cipher`** / **`integrity`** — swap the constant-pool cipher or the image checksum/MAC; a
  third-party algorithm's `decode`/`digest` is embedded into the JS artifact so it stays self-contained.

Every kind is verified against the multi-backend oracle by `testPlugin` — including a third-party
cipher+integrity round-tripped through a real standalone artifact.

A plugin author verifies their plugin against the multi-backend oracle with the SDK's own harness:

```js
const { definePlugin, registerOpcode, testPlugin } = require('./src/sdk');

// add a new instruction, then a pass that uses it -- no core changes
registerOpcode({ name: 'INC', operands: [], sem: [['let','a',['pop']], ['push',['bin','+',['var','a'],['lit',1]]]] });
const incFusion = definePlugin({ kind:'pass', name:'inc-fusion', stage:'optimize', run(fn, ctx){ /* [PUSH_CONST 1][ADD] -> [INC] */ } });

testPlugin(incFusion, [{ src: 'function f(n){ return n + 1; } print f(41);', expect: ['42'] }]);
// -> { passed: 1, failed: 0 }  (verified on interpreter, register machine, and JS VM)
```

See [STABILITY.md](STABILITY.md) for the versioned contract and tiers.

## Versioned, protected image

The artifact ships a compact **binary image** ([`src/core/image.js`](src/core/image.js)), not plaintext
JSON — decoded at load by a decoder embedded verbatim in the VM. It carries the protection layers and
the upgradeability seam, each algorithm **self-described by an id in the header** and swappable by a
plugin:

- **Self-describing header** — magic, format major/minor, feature flags, **cipher id**, **integrity
  id**. The decoder validates the major and dispatches on it, so a future format can read and migrate
  older images.
- **Integrity domain** (`kind:'integrity'`) — a checksum over the header meta *and* the body; a
  tampered artifact fails at load with `integrity check failed` (controlled failure). Built-ins: `fnv1a`
  and, with `sign`, a seed-keyed MAC `fnv1a-mac` — **signing**.
- **Constant-pool cipher** (`kind:'cipher'`) — the constant blob is transformed by the selected cipher
  (XOR keystream by default), so string/number literals are not stored in the clear.
- **Pluggable** — a third-party `cipher`/`integrity` (id ≥ 16) has its pure `decode`/`digest` **embedded
  verbatim** into the artifact, so the standalone VM stays self-contained.

```
prism: wrote out.js  [js/stack, format 1.1, 2 fns, 180B image, const-cipher, permuted, signed]
```

The conformance gate proves the binary path end to end: `encode → decode → run ≡ expected`, a flipped
byte (body *or* header, plain *or* signed) is rejected, a custom cipher+integrity round-trips through a
standalone artifact, and a plaintext literal never appears. Like the plan says, this is honest
obfuscation — the key ships in the artifact; it raises the cost of analysis, it is not cryptographic
protection.

### Protection, inline

Protection can be requested from the CLI/API **or from the source itself**, so a build is reproducible
from the file alone (explicit options still override):

```js
<@protect encrypt permute sign decoys=3 backend=js>
function fib(n){ if (n < 2) return n; return fib(n-1) + fib(n-2); }
print fib(10);
```

```bash
node src/cli.js build examples/fib.js --sign --permute --decoys 3   # or just: prism build fib.js
```

## Use it

```bash
node src/cli.js run     examples/fib.js               # compile + run on the interpreter
node src/cli.js build   examples/fib.js -o out.js      # emit a standalone JS VM
node src/cli.js build   examples/fib.js -t py -o out.py # emit a standalone Python VM
node src/cli.js build   examples/fib.js --decoys 3     # pad with 3 unreachable decoys
node src/cli.js analyze examples/fib.js                # function / scope report
npm test                                              # differential conformance gate
```

Programmatic API ([`src/api.js`](src/api.js)):

```js
const prism = require('./src');
const { code, image, meta } = prism.build(source, { target: 'js' });
const result = prism.run(source);        // -> { output, steps }
const report = prism.analyze(source);    // -> { functions: [{ name, params, locals }] }
```

## Language subset

`let`/`const`, numbers/strings/booleans/null, **arrays** (literals, `a[i]`, `a[i]=v`, `len(a)` /
`a.length`), `+ - * / %`, comparisons, `&& ||`, unary `- !`, `if/else`, `while`, **`for`**, ternary,
top-level functions with parameters & recursion, `console.log`/`print`. Enough to run real algorithms
— e.g. a bubble sort, which builds identically on all four machines:

```bash
node src/cli.js run examples/sort.js       # -> [1, 2, 3, 5, 8, 9]
```

Anything outside the subset throws a clear `Prism (slice): unsupported …` error — the subset keeps
growing; the pipeline around it is the point. Note the new array opcodes (`NEW_ARRAY`, `INDEX_GET`,
`INDEX_SET`, `LEN`) were added by declaring `sem` once — every backend, including Lua, gained them
with no hand-written handlers, only per-machine *value-model* primitives (`newArray` / `indexGet` /
`indexSet` / `len`) in each facade.

## Architecture

```
source → AST (reused vm-gen frontend) → image (compiler.js) → backends (generated from spec)
                                                             ├── interpreter (oracle)
                                                             └── standalone JS VM
```

| Piece | File | Role |
|---|---|---|
| Opcode spec | `src/core/spec.js` | single source of truth — portable `sem` per opcode |
| Code generator | `src/core/codegen.js` | lowers `sem` → JavaScript and Lua |
| Machine | `src/core/machine.js` | the shared JS VM facade + dispatch |
| Compiler | `src/core/compiler.js` | AST → image |
| Backends | `src/backends/{interp,emit-js,emit-js-reg,emit-lua,emit-py}.js` | five machines from one spec |
| Decoys | `src/core/decoys.js` | unreferenced decoy functions (a `kind:'decoy'` plugin) |
| Passes | `src/core/passes.js` | optimize + obfuscate pipeline (plugins) |
| Protection | `src/core/protect.js` | `cipher`/`integrity` registry (built-ins + resolver) |
| Inline pragma | `src/core/pragma.js` | `<@protect …>` — protection requested from source |
| Backend registry | `src/backends/registry.js` | `kind:'backend'` resolution (built-ins + custom) |
| Image | `src/core/image.js` | versioned binary + integrity/MAC + pluggable const cipher |
| Frontend | `src/frontend/*` | lexer + parser (reused from vm-gen) |
| Plugin registry | `src/core/plugin.js` | the extension seam (passes, backends, directives, …) |
| Versioning | `src/core/version.js` | image/bytecode/API versions + capability flags |
| API / CLI | `src/api.js`, `src/cli.js` | the one stable surface + a thin client |

## What's next (from the plan)

Phase 2 hardens the bytecode image (versioned binary + decoder). Phase 3 introduces the pass
pipeline and ports vm-gen's optimizations & obfuscations as **plugins**. Phase 4 adds the protected
image format, integrity domains, ciphers, and signing. Phase 5 generates Lua **and Python** backends
and a real register machine from the same spec. Phase 6 publishes the plugin SDK and freezes API 1.0.

## Reused from vm-gen

The lexer and parser are carried over verbatim. Proven algorithms return as spec-driven built-ins or
plugins rather than being reinvented: opcode permutation, **decoy functions** (`kind:'decoy'`), the
**constant-pool cipher** (`kind:'cipher'`), and a **keyed MAC / signing** (`kind:'integrity'`) are all
back; superinstruction fusion, tree-map string blobs, and the control-panel UI are next.

---

*Codename Prism — rename freely.*
