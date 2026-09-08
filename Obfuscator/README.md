# obfuscate.js

A Node.js CLI that transforms JavaScript source by:

- **Removing all comments** (line + block).
- **Minifying** — collapsing whitespace to a compact single stream.
- **Compressing variables** — renaming identifiers to short mangled names (`a`, `b`, `c`, …).
- **Compressing & encoding strings** — literals are lifted into a rotated/shuffled string array, base64- or RC4-encoded, and optionally split into chunks.
- **Control-flow obfuscation** — control-flow flattening plus optional dead-code injection.

It wraps the [`javascript-obfuscator`](https://github.com/javascript-obfuscator/javascript-obfuscator) engine with opinionated presets so you don't have to hand-tune ~40 options.

## Install

```bash
npm install
```

## Usage

```bash
# Single file -> sample.obf.js (default: medium preset)
node obfuscate.js sample.js

# Choose output name and intensity
node obfuscate.js sample.js -o dist/app.min.js --level heavy

# Whole directory (recurses .js/.cjs/.mjs) -> src-obf/
node obfuscate.js src/ -d dist/

# Pipe through stdin -> stdout
cat sample.js | node obfuscate.js - > out.js
```

### Flags

| Flag | Description |
|------|-------------|
| `-o, --out <file>` | Output file (single-file mode). |
| `-d, --out-dir <dir>` | Output directory (directory mode). |
| `-l, --level <preset>` | `light` \| `medium` \| `heavy` (default `medium`). |
| `--no-strings` | Keep string literals as-is (no string array). |
| `--no-control-flow` | Disable control-flow flattening + dead code. |
| `--no-rename` | Keep original identifier names. |
| `--self-defending` | Add anti-formatting / anti-debug guards. |
| `--seed <n>` | Deterministic output for a given seed. |

### Preset intensity

| | light | medium | heavy |
|---|---|---|---|
| Control-flow flattening | 35% | 75% | 100% |
| Dead-code injection | off | 20% | 40% |
| String array threshold | 60% | 85% | 100% |
| String encoding | base64 | base64 | rc4 |
| Split strings | off | 8-char | 5-char |
| Object-key transform | off | off | on |

## Notes

- Output is set for a **Node.js** target (`target: 'node'` in `obfuscate.js`). For browser bundles, change it to `'browser'`.
- Obfuscation is a code-protection / minification measure — it raises the cost of reading and reverse-engineering, but is not encryption. Anything the code needs at runtime (URLs, tokens it decodes) can still be recovered by a determined reader. Don't rely on it to hide genuine secrets.
- Heavy control-flow flattening and dead-code injection grow file size and add runtime overhead. Use `light`/`medium` for hot paths.
