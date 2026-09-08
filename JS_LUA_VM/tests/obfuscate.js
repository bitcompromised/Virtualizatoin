
'use strict';

/*
 * obfuscate.js
 *
 * Strips comments, minifies, renames (compresses) variables, encodes and
 * compresses string literals, and applies control-flow flattening to
 * JavaScript source.
 *
 * Usage:
 *   node obfuscate.js input.js                 -> writes input.obf.js
 *   node obfuscate.js input.js -o out.js       -> writes out.js
 *   node obfuscate.js src/ -d dist/            -> obfuscate every .js in src/ into dist/
 *   cat input.js | node obfuscate.js -         -> read stdin, write stdout
 *   node obfuscate.js input.js --level heavy   -> preset: light | medium | heavy
 *
 * Flags:
 *   -o, --out <file>       Output file (single-file mode).
 *   -d, --out-dir <dir>    Output directory (directory mode).
 *   -l, --level <preset>   light | medium | heavy   (default: medium)
 *       --no-strings       Do not encode/compress string literals.
 *       --no-control-flow  Disable control-flow flattening.
 *       --no-rename        Keep original identifier names.
 *       --seed <n>         Deterministic output for a given seed.
 *       --self-defending   Add anti-formatting / anti-debug guards.
 *   -h, --help             Show help.
 */

const fs = require('fs');
const path = require('path');

let JsObfuscator;
try {
  JsObfuscator = require('javascript-obfuscator');
} catch (err) {
  console.error(
    '\nMissing dependency: javascript-obfuscator\n' +
      'Install it first:\n\n  npm install\n\n' +
      '(or:  npm install javascript-obfuscator )\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    inputs: [],
    out: null,
    outDir: null,
    level: 'medium',
    strings: true,
    controlFlow: true,
    rename: true,
    selfDefending: false,
    seed: 0,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-o':
      case '--out':
        opts.out = argv[++i];
        break;
      case '-d':
      case '--out-dir':
        opts.outDir = argv[++i];
        break;
      case '-l':
      case '--level':
        opts.level = argv[++i];
        break;
      case '--no-strings':
        opts.strings = false;
        break;
      case '--no-control-flow':
        opts.controlFlow = false;
        break;
      case '--no-rename':
        opts.rename = false;
        break;
      case '--self-defending':
        opts.selfDefending = true;
        break;
      case '--seed':
        opts.seed = parseInt(argv[++i], 10) || 0;
        break;
      default:
        if (a.startsWith('-') && a !== '-') {
          console.error('Unknown flag: ' + a);
          process.exit(1);
        }
        opts.inputs.push(a);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Build javascript-obfuscator options from our presets/flags
// ---------------------------------------------------------------------------

function buildOptions(opts) {
  const level = String(opts.level).toLowerCase();
  if (!['light', 'medium', 'heavy'].includes(level)) {
    console.error("Invalid --level '" + level + "'. Use: light | medium | heavy");
    process.exit(1);
  }

  // Per-preset intensities.
  const preset = {
    light: {
      controlFlowFlatteningThreshold: 0.35,
      deadCodeInjection: false,
      deadCodeInjectionThreshold: 0,
      stringArrayThreshold: 0.6,
      stringArrayEncoding: ['base64'],
      splitStrings: false,
      splitStringsChunkLength: 10,
    },
    medium: {
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.2,
      stringArrayThreshold: 0.85,
      stringArrayEncoding: ['base64'],
      splitStrings: true,
      splitStringsChunkLength: 8,
    },
    heavy: {
      controlFlowFlatteningThreshold: 1,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.4,
      stringArrayThreshold: 1,
      stringArrayEncoding: ['rc4'],
      splitStrings: true,
      splitStringsChunkLength: 5,
    },
  }[level];

  return {
    // --- comment removal + minification ---
    compact: true, // collapse to minimal whitespace, strips comments

    // --- variable/identifier compression (renaming) ---
    renameGlobals: opts.rename,
    identifierNamesGenerator: opts.rename ? 'mangled-shuffled' : undefined,
    // 'mangled-shuffled' produces short compressed names (a, b, c, ...).
    // Use 'hexadecimal' for _0x-style names instead.

    // --- string encoding + compression ---
    stringArray: opts.strings,
    stringArrayEncoding: opts.strings ? preset.stringArrayEncoding : [],
    stringArrayThreshold: opts.strings ? preset.stringArrayThreshold : 0,
    stringArrayIndexShift: opts.strings,
    stringArrayRotate: opts.strings,
    stringArrayShuffle: opts.strings,
    stringArrayWrappersCount: opts.strings ? 2 : 0,
    stringArrayWrappersType: 'function',
    splitStrings: opts.strings && preset.splitStrings,
    splitStringsChunkLength: preset.splitStringsChunkLength,
    unicodeEscapeSequence: false,

    // --- control-flow obfuscation ---
    controlFlowFlattening: opts.controlFlow,
    controlFlowFlatteningThreshold: opts.controlFlow
      ? preset.controlFlowFlatteningThreshold
      : 0,
    deadCodeInjection: opts.controlFlow && preset.deadCodeInjection,
    deadCodeInjectionThreshold: preset.deadCodeInjectionThreshold,

    // --- misc hardening ---
    numbersToExpressions: level !== 'light',
    simplify: true,
    transformObjectKeys: level === 'heavy',
    selfDefending: opts.selfDefending,
    debugProtection: false, // opt-in; breaks devtools when true
    disableConsoleOutput: false,

    // --- determinism ---
    seed: opts.seed,
    target: 'node', // change to 'browser' for front-end bundles
  };
}

// ---------------------------------------------------------------------------
// Core transform
// ---------------------------------------------------------------------------

function obfuscateCode(source, options) {
  const result = JsObfuscator.obfuscate(source, options);
  return result.getObfuscatedCode();
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && /\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function defaultOutName(inputFile) {
  const ext = path.extname(inputFile);
  const base = inputFile.slice(0, -ext.length);
  return base + '.obf' + ext;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  const help = fs
    .readFileSync(__filename, 'utf8')
    .split('\n')
    .slice(4, 29)
    .map((l) => l.replace(/^ \*?/, '').trimEnd())
    .join('\n');
  console.log(help);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || opts.inputs.length === 0) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const options = buildOptions(opts);

  // stdin -> stdout
  if (opts.inputs.length === 1 && opts.inputs[0] === '-') {
    const source = fs.readFileSync(0, 'utf8');
    process.stdout.write(obfuscateCode(source, options) + '\n');
    return;
  }

  // directory mode
  const firstIsDir =
    opts.inputs.length === 1 &&
    fs.existsSync(opts.inputs[0]) &&
    fs.statSync(opts.inputs[0]).isDirectory();

  if (firstIsDir) {
    const srcDir = opts.inputs[0];
    const outDir = opts.outDir || srcDir.replace(/[\\/]+$/, '') + '-obf';
    const files = collectJsFiles(srcDir);
    if (files.length === 0) {
      console.error('No .js files found in ' + srcDir);
      process.exit(1);
    }
    for (const file of files) {
      const rel = path.relative(srcDir, file);
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const code = obfuscateCode(fs.readFileSync(file, 'utf8'), options);
      fs.writeFileSync(dest, code);
      console.error('obf  ' + rel);
    }
    console.error('\nDone. ' + files.length + ' file(s) -> ' + outDir);
    return;
  }

  // single/multi file mode
  if (opts.out && opts.inputs.length > 1) {
    console.error('-o/--out only works with a single input file.');
    process.exit(1);
  }

  for (const input of opts.inputs) {
    if (!fs.existsSync(input)) {
      console.error('No such file: ' + input);
      process.exit(1);
    }
    const source = fs.readFileSync(input, 'utf8');
    const code = obfuscateCode(source, options);
    const dest = opts.out || defaultOutName(input);
    fs.writeFileSync(dest, code);
    const before = Buffer.byteLength(source);
    const after = Buffer.byteLength(code);
    console.error(
      input + ' -> ' + dest + '  (' + before + ' -> ' + after + ' bytes)'
    );
  }
}

main();
