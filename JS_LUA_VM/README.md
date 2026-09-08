# vm-gen

**Compile JavaScript into a self-contained, per-build-unique, obfuscated virtual
machine — in JavaScript _or_ Lua.**

`vm-gen` takes a program (a broad subset of modern JavaScript, or the small
`.vgs` language), compiles it to bytecode, applies control-flow and constant
obfuscation, and emits a **single standalone VM file** that embeds the program as
an encrypted, integrity-checked *image* and runs it with a stock runtime — no
dependency on vm-gen. Every build is **different**: opcodes are randomly remapped,
seeds and the permutation are *derived, never stored*, internal VM identifiers are
randomized, and the bytecode is freshly encrypted and obfuscated.

```bash
node bin/vm-gen.js run   app.js                 # compile + run on the reference interpreter
node bin/vm-gen.js build app.js -o app.vm.js    # emit a standalone protected JS VM
node bin/vm-gen.js build app.js -t lua -o app.vm.lua
node app.vm.js                                  # runs anywhere Node runs
```

---

## Table of contents
- [Input language](#input-language)
- [Inline directives](#inline-directives)
- [Build profiles](#build-profiles)
- [Obfuscation & protection](#obfuscation--protection)
- [CLI reference](#cli-reference)
- [Interactive mode & drag-and-drop](#interactive-mode--drag-and-drop)
- [Build summary log](#build-summary-log)
- [Runtime & security model](#runtime--security-model)
- [Programmatic API](#programmatic-api)
- [Architecture](#architecture)

---

## Input language

vm-gen accepts a large subset of modern JavaScript directly (`.js`), plus the
compact `.vgs` dialect. Supported constructs include:

- `let`/`const`/`var`, `function`/`fn`, arrow functions, `async`/`await`
- `if`/`else`, `while`, `for`, `for…of`/`for…in`, `break`/`continue`, ternaries
- objects & arrays, computed keys, getters/setters, method shorthand, spread
- destructuring (object/array, in bindings, params, `catch`, `for…of`)
- classes (`extends`, `constructor`, methods, `static`, `instanceof`)
- `try`/`catch`/`finally`, `throw`, template literals, regex literals
- closures/upvalues (survive after the outer function returns)
- `import`/`export` and dynamic `require(...)` (bridged to real host modules)
- host globals by name (`console`, `Math`, `JSON`, `Object`, `Map`, `Set`,
  `Promise`, `Proxy`, `Symbol`, …) and native method calls

**Semicolons are optional** — a newline (ASI-lite) ends a statement, so the
parser is not semicolon- or whitespace-dependent.

VM objects are backed by **real JS objects**, so `Object.keys`,
`Object.defineProperty`, `Object.create`, `Proxy`, and `Symbol` keys work
natively while `Promise`/`.then`/`.catch`/`await` use real promises.

---

## Inline directives

Directives are written inline as `<@name args…>` and instruct the compiler to
protect, rename, or transform code. They apply to the **next** statement,
function, binding, or expression.

### Function / block directives

| Directive | Effect |
|---|---|
| `<@native>` | Do **not** virtualize/encrypt this function (fastest, least protected). |
| `<@virtualization min\|med\|max>` | Protection strength (opaque predicates, flattening, dead paths, string storage at med+, mutated handlers). |
| `<@flat>` | **Control-flow flattening** — reduce structured flow to a randomized block layout driven by jump edges. |
| `<@bogus min\|med\|max>` | **Bogus control flow** — opaque predicates, dead states, unreachable code clones. |
| `<@split>` | **Basic-block splitting** — fragment straight-line runs into smaller blocks. |
| `<@deadcode min\|med\|max>` | Inject decoy functions of varying frequency/ambition. |
| `<@controlFlow min\|med\|max>` | Flatten control flow in the following function/block. |
| `<@sourcemap on\|off>` | Keep/drop source mapping metadata. |

### Naming directives (functions & variables)

| Directive | Effect |
|---|---|
| `<@name str>` | Rename the binding to `str` **and every reference to it**. |
| `<@name>` | Rename to a random identifier (references updated too). |

```js
const <@name test>secret = "top-secret-token-44";   // `secret` becomes `test` everywhere
function <@name calc>add(a, b){ return a + b }        // `add` -> `calc`
let f = (<@name>a) => a * 2;                          // param `a` -> random name
```

### Value directives (inline expressions)

| Directive | Produces |
|---|---|
| `<@encstr str hex\|str_arr\|bytecode\|random>` | The string, reconstructed at runtime so the literal never appears in the pool. |
| `<@encstr hex>"world"` | Prefix form — encodes the following string literal. |
| `<@encstr hex>42` | Prefix form on a number — a runtime integer reconstruction. |
| `<@random max min>` | A random integer in `[min, max]` at runtime. |

```js
if (a == <@encstr dog bytecode>) return 1;   // -> String.fromCharCode(100,111,103)
console.log(<@random 6 1>);                  // 1..6
```

### Code directives (expand to statements / expressions)

| Directive | Expands to |
|---|---|
| `<@fn name(args){ body }>` / `<@function …>` | A function declaration. |
| `<@call f(args)>` | A call (statement or value). |
| `<@log ...msg>` / `<@warn ...msg>` | `console.log` / `console.warn` of the (space-separated) args. |
| `<@if a b>` | `a ? b : null`. |
| `<@exists v>` | `typeof v !== "undefined"`. |
| `<@throw err>` | `throw err`. |
| `<@quit>` | Exit the current function (ends the program at top level). |
| `<@dudret v>` | A **decoy return** guarded by an opaque predicate — never taken. |
| `<@decoy x>` | Spawn an inert **decoy function** of strength `x` (0–3), reported as `deadcode`. |

Code directives may **nest**: `<@dudret <@encstr hex>"x">`, `<@log "sum" <@call f()>>`.

```js
<@fn add(a, b){ return a + b }>
const r = <@call add(2, 3)>
<@log "sum =" r>
if (r > 100) { <@throw "too big"> }
```

---

## Build profiles

`--profile <name>` selects a preset; **every individual knob below overrides it**,
so you can start from a profile and dial any single dimension up or down.

| Profile | optimize | permute | conceal | dud | fuse | flatten | bogus | split | cipher rounds | encstr | limits |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `development` | off | identity | off | off | off | off | 0 | off | 0 | none | none |
| `balanced` (default) | on | on | off | off | off | off | 0 | off | 1 | none | depth 1024 |
| `aggressive` | on | on | on | on | on | on | 2 | on | 2 | random | steps/depth/objects/string |
| `performance` | on | on | off | off | off | off | 0 | off | 1 | none | none |

The control-flow knobs (`flatten` / `bogus` / `split`), `cipher rounds`
(`--prot-level`), `conceal`, `fuse`, and `permute` apply to **every function** as
a global floor; per-function `<@flat>`/`<@bogus>`/`<@split>` directives still layer
on top. `encstr` is a **JS-target** feature (it reconstructs each string literal at
runtime via `String.fromCharCode`/`Array.join`); it is ignored for the Lua target,
where the constant-pool cipher and `conceal` still hide strings.

---

## Obfuscation & protection

- **Per-build opcode permutation** — every build maps canonical opcodes to random
  bytes; the permutation is **derived from a hidden master seed, never stored**.
- **Derived seeds** — the two cipher seeds and the opcode table are regenerated at
  load from an obfuscated master value; the salt lives in the VM, not the image.
- **Bytecode encryption** — each function's stream is XOR-encrypted with keyed,
  per-function, multi-round keystreams (rounds scale with protection level).
- **Constant concealment** — strings and integers can be stored as unsolved
  expressions instead of literals.
- **Control-flow obfuscation** — `<@flat>` / `<@bogus>` / `<@split>` per function.
- **Combined opcodes** — superinstruction fusion (`LOAD;ADD → LOADADD`, …) on both
  JS and Lua targets (aggressive profile).
- **Symbol renaming** — all compiled function/upvalue/catch names are renamed to
  opaque randoms by default.
- **VM randomization** — the emitted VM's internal identifiers are randomized every
  build, the output is minified, the dispatch handlers can be shuffled
  (`--mutate-handlers`), and the loader takes a per-build form (`--loader-form`).
- **VM architecture** (`--arch`, JS target) — the execution substrate can be a
  `stack-switch` machine (default) or a **register-based** one (`register` /
  `register-threaded` / `register-encrypted`): an indexed register file addressed
  by a stack pointer, with the encrypted variant holding the pointer masked.
  Behaviour is identical; only the machine model differs.
- **Multi-domain integrity** — independent checksums over header, dispatch table,
  constants, functions, plus a master checksum; tamper is localized and detected.
- **Decoy functions** — inert, well-formed "dud" functions padded into the image.
- **Optional signing** — `--sign <key>` embeds a keyed MAC; the VM runs only when
  `VMGEN_KEY` matches.
- **Resource limits** — max instructions / call depth / object count / string size,
  enforced at runtime with controlled failure.

Every transform is **behavior-preserving**: protection never changes semantics.

---

## CLI reference

```
vm-gen <command> <file> [options]

Commands:
  run <file>          Compile and run on the reference interpreter
  build <file>        Emit a standalone protected VM
  exec <file>         Run with optional --trace
  disasm <file>       Print canonical (pre-protection) bytecode
  benchmark <file>    Measure compile/build/exec time, size, instruction counts
  interactive [file]  Interactive settings console (see below)
  ui [file]           Local web control panel: per-function toggles + settings

Options:
  -t, --target js|lua        Output language (default js)
  -p, --profile <name>       development | balanced | aggressive | performance
  -o, --out <path>           Output file
      --seed <n>             Deterministic, reproducible build
      --sign <key>           Embed keyed signature (VM checks env VMGEN_KEY)
      --max-steps <n>        Instruction budget (0 = unlimited)
      --max-depth <n>        Call-depth limit
      --no-optimize          Disable compile-time optimizer
      --dud / --no-dud       Force decoy functions on/off
      --dud-count <n>        Number of decoys

  Protection knobs (override the profile; apply to every function):
      --flatten / --no-flatten   Control-flow flattening
      --bogus <0-3>              Bogus control-flow intensity
      --split / --no-split       Basic-block splitting
      --prot-level <0-3>         Cipher rounds per function
      --encstr <mode>            Encrypt strings: none|str_arr|hex|bytecode|random (JS only)
      --conceal / --no-conceal   Store integers as unsolved XOR expressions
      --fuse / --no-fuse         Superinstruction (opcode) fusion
      --permute / --no-permute   Randomize the opcode table
      --mutate-handlers          Shuffle the dispatch handlers each build
      --loader-form <form>       VM loader shape: auto | compact | verbose | split
      --prod / --production      Terse runtime errors (dev builds print the VM
                                 position + host stack on an uncaught error)
      --max-objects <n>          Cap live object/array allocations (0 = off)
      --max-string <n>           Cap single-string length (0 = off)

      --no-rename            Keep original symbol names
      --no-randomize         Keep stable VM identifiers
      --no-summary           Do not write <out>_summary.txt
  -q, --quiet                One-line build output
  -i, --interactive          Launch the interactive console
      --no-banner            Omit the generated-file header
  -v, --version              Version info
  -h, --help                 Help
```

The `build` command also writes a detailed **`<out>_summary.txt`** log (disable
with `--no-summary`) and prints a build report of config, per-function
modifications, and statistics.

---

## Web control panel

`vm-gen ui [file]` starts a local control panel (binds to `127.0.0.1` only, no
data leaves the machine) at `http://127.0.0.1:7842/`:

- **Analyze functions** lists every function with its scope — parameters, locals,
  and captured upvalues **by name** — and flags any inline `<@…>` directives.
- **Per-function protection**: toggle `flatten` / `split` / `bogus` (0–3) /
  `cipher rounds` (0–3) on individual functions. These override the global
  defaults for just that function; bulk actions apply one toggle to all.
- Settings are split into two groups:
  - **VM-interpreter** — how the engine itself is built: opcode permutation,
    superinstruction fusion, integer concealment, default cipher rounds,
    **mutate opcode handlers** (shuffle the dispatch per build), and **loader
    form** (`auto`/`compact`/`verbose`/`split`).
  - **VM-child** — how the guest program is protected: global flatten/bogus/split,
    string encryption, decoy functions, symbol renaming, optimization.
- **Build** shows the summary (including the *Added code* report), the emitted VM
  source, live stats, and a **Download VM** button.

Function indices track the current `optimize` setting, so re-analyze after
toggling it. `vm-gen ui --port <n>` chooses a different port.

---

## Interactive mode & drag-and-drop

Run `vm-gen interactive` (or `-i`, or just drop a `.js`/`.vgs` file onto
`vm-gen`) to open a console where **every setting can be toggled/modified**
before building:

```
vm-gen interactive build
========================================
   1. input file       app.js
   3. target           js
   4. profile          balanced
   5. optimize         true
   6. permute opcodes  true
   7. conceal ints     false
   8. flatten CF       false
   9. bogus CF (0-3)   off
  10. split blocks     false
  11. cipher rounds    1
  12. encrypt strings  none
  13. fuse opcodes     false
   ...
   b. build      q. quit

select # to change (or b/q):
```

Selecting a numbered protection knob toggles it (booleans) or prompts for a value
(`bogus`/`cipher rounds` 0–3, `encrypt strings` mode). Choosing a **profile**
resets every knob to that profile's floor, which you can then fine-tune.

On Windows, dragging a source file onto the `vm-gen` executable/`.cmd` opens this
console pre-loaded with that file (quoted paths with spaces are handled).

---

## Build summary log

Each `build` writes `<out>_summary.txt` containing:

- the full **configuration** used,
- the **raw source** input,
- the **symbol rename table** (`original -> obfuscated`),
- for **every function**: params/locals/level, the **scope** (variable names by
  slot), which obfuscation passes ran and **how many instructions they added**,
  and the post-protection **disassembly**,
- the **constant pool**, and overall **statistics**.

---

## Runtime & security model

The emitted VM verifies itself at startup (magic, format version, opcode-table
match, and each integrity domain) and fails **controlled** on tamper or resource
exhaustion — no stack traces leak internals. Signed artifacts additionally verify
a keyed MAC against `VMGEN_KEY`.

**What this is:** strong obfuscation and tamper-detection that raises the cost of
static and dynamic analysis significantly. **What it is not:** unbreakable DRM —
the salt and logic ship inside the artifact, so a determined analyst with the VM
can recover keys. For higher assurance, combine signing with a server-backed
secret in `VMGEN_KEY`.

---

## Programmatic API

```js
const { generate, compile, buildImage, disassemble } = require('vm-gen/src/generate');
const { interpret } = require('vm-gen/src/interp');

// One-shot: source -> standalone VM source (+ rich metadata).
const { output, program, image, meta } = generate(src, {
  target: 'js',            // or 'lua'
  profile: 'aggressive',
  seed: 42,                // reproducible build
  renameSymbols: true,
  fuse: true, minify: true, randomize: true,
});
// output  -> the standalone VM source string
// meta     -> { profile, flags, imageSize, checksum, numFns, dudFns,
//              modifications:[{name,level,async,mods}], renameCount, summary }

// Lower level:
const prog  = compile(src, { optimize: true, fuse: true, seed: 42 });
const { image, meta } = buildImage(prog, { seed: 42, profile: 'aggressive', conceal: true, dud: true });
const text  = disassemble(prog);           // canonical, pre-protection bytecode
const result = await interpret(prog);      // reference interpreter -> { output, steps, ... }
```

Key `generate` options: `target`, `profile`, `seed`, `optimize`, `permute`,
`conceal`, `flatten`, `bogus` (0–3), `split`, `protLevel` (0–3), `encStr`
(`none`|`str_arr`|`hex`|`bytecode`|`random`), `dud`/`dudCount`, `fuse`,
`renameSymbols`, `randomize`, `minify`, `sign`,
`maxSteps`/`maxDepth`/`maxObjects`/`maxString`, `sourceDir`, `resolveImport`.
Any of the protection knobs, when passed explicitly, overrides the profile's
floor and applies to every function.

---

## Architecture

```
source ─▶ lexer ─▶ parser ─▶ optimizer ─▶ compiler ─▶ transforms ─▶ protect ─▶ emit(js|lua)
                    (AST)      (AST)        (bytecode)   (obfusc.)    (image)     (standalone VM)
```

| Module | Role |
|---|---|
| `src/lexer.js` | Tokenizer (ASI newline tracking, directives, BigInt/regex). |
| `src/parser.js` | Recursive-descent parser + directive handling + rename passes. |
| `src/optimize.js` | Constant folding/propagation, DCE, jump/peephole (behavior-preserving). |
| `src/compiler.js` | AST → bytecode, scopes/upvalues, superinstruction fusion. |
| `src/transforms.js` | `<@flat>`/`<@bogus>`/`<@split>` bytecode obfuscation passes. |
| `src/protect.js` | Opcode permutation, cipher, integrity domains, decoys, image format. |
| `src/emit-js.js` / `src/emit-lua.js` | Standalone VM emitters (randomized, minified). |
| `src/interp.js` | Reference interpreter (behavioral oracle; async-aware). |
| `src/generate.js` | Pipeline + rename + build report + summary. |
| `src/hostenv.js` | Host global table + `require` bridge for the interpreter. |

Run `node test/run.js` for the JS+Lua parity and integrity test suite.
