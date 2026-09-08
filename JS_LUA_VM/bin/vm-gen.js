#!/usr/bin/env node
'use strict';
// vm-gen command-line interface.
//
//   vm-gen build     <source> [--target js|lua] [--profile P] [-o out] [--seed N]
//   vm-gen run       <source>            compile to JS in-memory and execute
//   vm-gen exec      <source> [--trace]  run on the reference interpreter (oracle)
//   vm-gen disasm    <source>            print canonical bytecode (pre-protection)
//   vm-gen benchmark <source> [--profile P]
//
// <source> may be a .vgs program or a .js file in the supported subset.
//
const fs = require('fs');
const path = require('path');
const { generate, compile, disassemble } = require('../src/generate');
const { interpret } = require('../src/interp');
const { benchmark, formatReport } = require('../src/benchmark');
const V = require('../src/version');

function usage() {
  console.log(`vm-gen -- generate protected Lua & JS virtual machines

Usage:
  vm-gen build     <source> [options]   Compile to a standalone protected VM
  vm-gen run       <source>             Compile + execute immediately (JS backend)
  vm-gen exec      <source> [--trace]   Run on the reference interpreter (oracle)
  vm-gen disasm    <source>             Print canonical bytecode (pre-protection)
  vm-gen benchmark <source> [options]   Profile compile/build/run metrics
  vm-gen ui        [source]             Launch the local web control panel
  vm-gen interactive [source]           Terminal settings console

<source> is a .vgs program or a .js file in the supported subset.

Options:
  --target, -t   js | lua                Target VM language (default: js)
  --profile, -p  development | balanced | aggressive | performance
                                         Build profile (default: balanced)
  --out, -o      <file>                  Output path (default: <source>.vm.<ext>)
  --seed         <number>                Deterministic build seed (default: random)
  --max-steps    <number>                Runtime instruction budget (0 = unlimited)
  --max-depth    <number>                Runtime call-depth limit (0 = unlimited)
  --sign         <key>                   Embed a keyed signature; the VM then runs
                                         only when env VMGEN_KEY matches this key
  --no-optimize                          Disable compile-time optimization
  --dud, --no-dud                        Force decoy ("dud") functions on/off
                                         (default: on for the aggressive profile)
  --dud-count    <number>                Number of decoy functions to inject

 Protection knobs (each overrides the profile; apply to EVERY function, and
 per-function <@flat>/<@bogus>/<@split> directives still override these):
  --flatten, --no-flatten                Control-flow flattening on all functions
  --bogus        <0-3>                    Bogus control-flow intensity (0 = off)
  --split, --no-split                    Basic-block splitting on all functions
  --prot-level   <0-3>                   Cipher rounds per function (default 1)
  --encstr       <mode>                  Encrypt string literals: none | str_arr |
                                         hex | bytecode | random | tree
                                         (tree = shared-blob substring extrapolation)
  --enc-num                              Encrypt integer literals (XOR reconstruction)
  --conceal, --no-conceal                Store integers as unsolved XOR expressions
  --fuse, --no-fuse                      Superinstruction (opcode) fusion
  --permute, --no-permute                Randomize the opcode table
  --mutate-handlers                      Shuffle the dispatch handlers per build
  --loader-form  <form>                  VM loader shape: auto | compact | verbose | split
  --arch         <name>                  VM architecture (JS target): stack-switch |
                                         register | register-threaded | register-encrypted
  --prod, --production                   Terse runtime errors (dev builds are verbose)
  --max-objects  <number>                Cap live object/array allocations (0 = off)
  --max-string   <number>                Cap single-string length (0 = off)
  --no-banner                            Omit the generated-file header comment
  --trace                                (exec) print a full execution trace
  --version, -v                          Print version information
  --help, -h                             Show this help

Profiles: ${V.PROFILE_NAMES.join(', ')}`);
}

function versionInfo() {
  console.log(`vm-gen
  compiler   ${V.COMPILER_VERSION}
  format     ${V.FORMAT_MAJOR}.${V.FORMAT_MINOR}
  vm-abi     ${V.VM_ABI_VERSION}
  bytecode   ${V.BYTECODE_VERSION}
  protection ${V.PROTECTION_VERSION}`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '-t') opts.target = argv[++i];
    else if (a === '--profile' || a === '-p') opts.profile = argv[++i];
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--max-steps') opts.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--max-depth') opts.maxDepth = parseInt(argv[++i], 10);
    else if (a === '--sign') opts.sign = argv[++i];
    else if (a === '--arch') opts.arch = argv[++i];
    else if (a === '--no-optimize') opts.optimize = false;
    else if (a === '--dud') opts.dud = true;
    else if (a === '--no-dud') opts.dud = false;
    else if (a === '--dud-count') opts.dudCount = parseInt(argv[++i], 10);
    // ---- granular protection knobs (override the profile, per build) ----
    else if (a === '--flatten') opts.flatten = true;
    else if (a === '--no-flatten') opts.flatten = false;
    else if (a === '--bogus') opts.bogus = parseInt(argv[++i], 10);
    else if (a === '--no-bogus') opts.bogus = 0;
    else if (a === '--split') opts.split = true;
    else if (a === '--no-split') opts.split = false;
    else if (a === '--prot-level' || a === '--protlevel') opts.protLevel = parseInt(argv[++i], 10);
    else if (a === '--encstr') opts.encStr = String(argv[++i] || '').toLowerCase();
    else if (a === '--no-encstr') opts.encStr = 'none';
    else if (a === '--enc-num' || a === '--encnum') opts.encNum = true;
    else if (a === '--no-enc-num') opts.encNum = false;
    else if (a === '--conceal') opts.conceal = true;
    else if (a === '--no-conceal') opts.conceal = false;
    else if (a === '--fuse') opts.fuse = true;
    else if (a === '--no-fuse') opts.fuse = false;
    else if (a === '--permute') opts.permute = true;
    else if (a === '--no-permute') opts.permute = false;
    else if (a === '--mutate-handlers') opts.mutateHandlers = true;
    else if (a === '--no-mutate-handlers') opts.mutateHandlers = false;
    else if (a === '--loader-form') opts.loaderForm = String(argv[++i] || '').toLowerCase();
    else if (a === '--max-objects') opts.maxObjects = parseInt(argv[++i], 10);
    else if (a === '--max-string') opts.maxString = parseInt(argv[++i], 10);
    else if (a === '--no-banner') opts.banner = false;
    else if (a === '--prod' || a === '--production') opts.prod = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--no-summary') opts.summary = false;
    else if (a === '--no-rename') opts.renameSymbols = false;
    else if (a === '--no-randomize') opts.randomize = false;
    else if (a === '--trace') opts.trace = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--interactive' || a === '-i') opts.interactive = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

// Strip surrounding quotes (CMD wraps drag-dropped paths containing spaces).
function unquote(s) { return s ? s.replace(/^["']|["']$/g, '') : s; }

// Interactive settings console: toggle/modify every build setting, then build.
// Also the drag-and-drop entry point (dropping a file onto vm-gen.cmd lands here).
async function interactiveBuild(initialFile) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const base = V.PROFILE_CONFIG.balanced;
  const s = {
    file: unquote(initialFile) || '', out: '', target: 'js', profile: 'balanced',
    optimize: base.optimize, permute: base.permute, conceal: base.conceal, dud: base.dud,
    flatten: !!base.flatten, bogus: base.bogus | 0, split: !!base.split,
    protLevel: base.protLevel != null ? base.protLevel : 1, encStr: base.encStr || 'none',
    fuse: !!base.fuse, renameSymbols: true, minify: true, randomize: true, summary: true,
    sign: '', maxSteps: base.maxSteps, maxDepth: base.maxDepth, seed: undefined,
  };
  const applyProfile = (p) => {
    const c = V.PROFILE_CONFIG[p]; if (!c) return false;
    s.profile = p; s.optimize = c.optimize; s.permute = c.permute; s.conceal = c.conceal;
    s.dud = c.dud; s.fuse = !!c.fuse; s.maxSteps = c.maxSteps; s.maxDepth = c.maxDepth;
    s.flatten = !!c.flatten; s.bogus = c.bogus | 0; s.split = !!c.split;
    s.protLevel = c.protLevel != null ? c.protLevel : 1; s.encStr = c.encStr || 'none'; return true;
  };
  const ENC_MODES = ['none', 'str_arr', 'hex', 'bytecode', 'random', 'tree'];
  // ordered list of editable keys -> menu rows
  const KEYS = ['file', 'out', 'target', 'profile', 'optimize', 'permute', 'conceal',
    'flatten', 'bogus', 'split', 'protLevel', 'encStr', 'fuse', 'dud',
    'renameSymbols', 'minify', 'randomize', 'summary', 'sign', 'maxSteps', 'maxDepth', 'seed'];
  const LABEL = {
    file: 'input file', out: 'output', target: 'target', profile: 'profile',
    optimize: 'optimize', permute: 'permute opcodes', conceal: 'conceal ints',
    flatten: 'flatten CF', bogus: 'bogus CF (0-3)', split: 'split blocks',
    protLevel: 'cipher rounds', encStr: 'encrypt strings', fuse: 'fuse opcodes', dud: 'dud (decoys)',
    renameSymbols: 'rename symbols', minify: 'minify', randomize: 'randomize VM',
    summary: 'summary log', sign: 'sign key', maxSteps: 'max steps', maxDepth: 'max depth', seed: 'seed',
  };
  const shown = (k) => {
    if (k === 'file') return s.file || '(none - required)';
    if (k === 'out') return s.out || '(auto)';
    if (k === 'sign') return s.sign || '(none)';
    if (k === 'seed') return s.seed === undefined ? '(random)' : s.seed;
    if (k === 'bogus') return s.bogus ? 'level ' + s.bogus : 'off';
    return s[k];
  };
  console.log('\nvm-gen interactive build\n' + '='.repeat(40));
  for (;;) {
    console.log('');
    KEYS.forEach((k, i) => console.log(`  ${String(i + 1).padStart(2)}. ${LABEL[k].padEnd(16)} ${shown(k)}`));
    console.log('   b. build      q. quit');
    const ans = (await ask('\nselect # to change (or b/q): ')).trim().toLowerCase();
    if (ans === 'q') { rl.close(); return; }
    if (ans === 'b') break;
    const n = parseInt(ans, 10);
    const key = KEYS[n - 1];
    if (!key) { console.log('  ? invalid choice'); continue; }
    if (typeof s[key] === 'boolean') { s[key] = !s[key]; }
    else if (key === 'profile') { const v = (await ask(`  profile (${V.PROFILE_NAMES.join('/')}): `)).trim(); if (!applyProfile(v)) console.log('  ? unknown profile'); }
    else if (key === 'target') { const v = (await ask('  target (js/lua): ')).trim().toLowerCase(); if (v === 'js' || v === 'lua') s.target = v; }
    else if (key === 'encStr') { const v = (await ask(`  encrypt strings (${ENC_MODES.join('/')}): `)).trim().toLowerCase(); if (ENC_MODES.includes(v)) s.encStr = v; else console.log('  ? unknown mode'); }
    else if (key === 'bogus') { const v = (await ask('  bogus CF level (0-3): ')).trim(); const nn = parseInt(v, 10); s.bogus = isNaN(nn) ? 0 : Math.max(0, Math.min(3, nn)); }
    else if (key === 'protLevel') { const v = (await ask('  cipher rounds (0-3): ')).trim(); const nn = parseInt(v, 10); s.protLevel = isNaN(nn) ? 1 : Math.max(0, Math.min(3, nn)); }
    else if (key === 'maxSteps' || key === 'maxDepth' || key === 'seed') { const v = (await ask(`  ${key}: `)).trim(); s[key] = v === '' ? (key === 'seed' ? undefined : 0) : parseInt(v, 10); }
    else { s[key] = unquote((await ask(`  ${key}: `)).trim()); }
  }
  rl.close();
  if (!s.file) { console.error('error: no input file'); process.exit(2); }
  const source = fs.readFileSync(s.file, 'utf8');
  const out = s.out || (s.file.replace(/\.[^.]+$/, '') + '.vm' + (s.target === 'lua' ? '.lua' : '.js'));
  const baseDir = path.dirname(path.resolve(s.file));
  const resolveImport = (p) => fs.readFileSync(path.resolve(baseDir, p), 'utf8');
  const { output, meta } = generate(source, {
    target: s.target, seed: s.seed, profile: s.profile, optimize: s.optimize,
    maxSteps: s.maxSteps, maxDepth: s.maxDepth, sign: s.sign || undefined, dud: s.dud,
    fuse: s.fuse, renameSymbols: s.renameSymbols, randomize: s.randomize, minify: s.minify,
    permute: s.permute, conceal: s.conceal, flatten: s.flatten, bogus: s.bogus,
    split: s.split, protLevel: s.protLevel, encStr: s.encStr,
    resolveImport, sourceDir: baseDir,
  });
  fs.writeFileSync(out, output);
  if (s.summary) fs.writeFileSync(out.replace(/\.[^.]+$/, '') + '_summary.txt', meta.summary);
  console.log(`\n✓ wrote ${path.relative(process.cwd(), out)} (${s.target}, ${meta.numFns} fns, ${meta.imageSize}B image)`);
  if (s.summary) console.log(`✓ wrote build summary`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) { versionInfo(); return; }
  const cmd = opts._[0];
  // Interactive / drag-and-drop entry: `vm-gen`, `vm-gen -i`, or a file dropped
  // straight onto the executable (cmd is an existing .js/.vgs path, no command).
  if (opts.interactive || cmd === 'interactive' || cmd === 'config'
      || (cmd && !['build', 'run', 'exec', 'disasm', 'benchmark'].includes(cmd) && /\.(js|vgs|mjs)$/i.test(unquote(cmd)) && fs.existsSync(unquote(cmd)))) {
    await interactiveBuild(cmd === 'interactive' || cmd === 'config' ? opts._[1] : cmd);
    return;
  }
  // Local web UI: per-function protection toggles + interpreter/child settings.
  if (cmd === 'ui') {
    const { serve } = require('./ui-server');
    const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
    const initial = opts._[1] ? path.resolve(unquote(opts._[1])) : '';
    serve(html, opts.port || 7842, initial);
    return;
  }

  if (opts.help || !cmd) { usage(); return; }

  const file = opts._[1];
  if (!file) { console.error('error: missing source file'); process.exit(2); }
  const source = fs.readFileSync(file, 'utf8');

  // Resolve `import "x"` relative to the main source file's directory.
  const baseDir = path.dirname(path.resolve(file));
  const resolveImport = (p) => fs.readFileSync(path.resolve(baseDir, p), 'utf8');

  if (cmd === 'disasm') {
    console.log(disassemble(compile(source, { optimize: opts.optimize, resolveImport })));
    return;
  }

  if (cmd === 'exec') {
    // Reference interpreter: no protection, optional debug trace.
    const program = compile(source, { optimize: opts.optimize, resolveImport });
  const res = await interpret(program, { trace: opts.trace });
    if (opts.trace) {
      for (const t of res.trace) {
        console.error(`#${String(t.step).padStart(5)} ${t.fn}@${t.i} ${t.op}`
          + `${t.args.length ? ' ' + t.args.join(',') : ''}`
          + `  stack=[${t.stack.map(String).join(', ')}]`);
      }
      console.error(`-- ${res.steps} steps --`);
    }
    for (const line of res.output) process.stdout.write(line + '\n');
    return;
  }

  if (cmd === 'run') {
    // For faster development and correct semantics (top-level await), run on the reference interpreter.
    const program = compile(source, { optimize: opts.optimize, resolveImport });
    const res = await interpret(program, { trace: opts.trace, maxSteps: opts.maxSteps, dir: path.dirname(path.resolve(file)) });
    if (opts.trace) {
      for (const t of res.trace) {
        console.error(`#${String(t.step).padStart(5)} ${t.fn}@${t.i} ${t.op}`
          + `${t.args.length ? ' ' + t.args.join(',') : ''}`
          + `  stack=[${t.stack.map(String).join(', ')}]`);
      }
      console.error(`-- ${res.steps} steps --`);
    }
    for (const line of res.output) process.stdout.write(line + '\n');
    return;
  }

  if (cmd === 'benchmark' || cmd === 'bench') {
    const r = benchmark(source, { seed: opts.seed, profile: opts.profile, optimize: opts.optimize, maxSteps: opts.maxSteps, maxDepth: opts.maxDepth, resolveImport });
    console.log(formatReport(path.basename(file), r));
    return;
  }

  if (cmd === 'build') {
    const target = (opts.target || 'js').toLowerCase();
    const ext = target === 'lua' ? '.lua' : '.js';
    const out = opts.out || (file.replace(/\.[^.]+$/, '') + '.vm' + ext);
    const { output, meta } = generate(source, {
      target, banner: opts.banner, seed: opts.seed, profile: opts.profile,
      optimize: opts.optimize, maxSteps: opts.maxSteps, maxDepth: opts.maxDepth, sign: opts.sign,
      dud: opts.dud, dudCount: opts.dudCount, arch: opts.arch, resolveImport,
      sourceDir: path.dirname(path.resolve(file)),
      renameSymbols: opts.renameSymbols, randomize: opts.randomize,
      // granular protection knobs (undefined => inherit from profile)
      flatten: opts.flatten, bogus: opts.bogus, split: opts.split, protLevel: opts.protLevel,
      encStr: opts.encStr, encNum: opts.encNum, conceal: opts.conceal, fuse: opts.fuse, permute: opts.permute,
      maxObjects: opts.maxObjects, maxString: opts.maxString, prod: opts.prod,
      mutateHandlers: opts.mutateHandlers, loaderForm: opts.loaderForm,
    });
    fs.writeFileSync(out, output);
    // Detailed build log (raw source, scope names, obfuscation, disassembly).
    if (opts.summary !== false) {
      const sumPath = out.replace(/\.[^.]+$/, '') + '_summary.txt';
      fs.writeFileSync(sumPath, meta.summary);
      if (!opts.quiet) console.error(`vm-gen: wrote ${path.relative(process.cwd(), sumPath)}`);
    }
    if (opts.quiet) {
      console.error(`vm-gen: wrote ${path.relative(process.cwd(), out)} (${target}, ${meta.numFns} fns, image ${meta.imageSize}B)`);
      return;
    }
    // ---- build report ----
    const line = (s) => console.error(s);
    line('');
    line(`vm-gen build report  ->  ${path.relative(process.cwd(), out)}`);
    const c = meta.cfg || {};
    const onoff = (b) => (b ? 'on' : 'off');
    line('  config:');
    line(`    target       ${target}`);
    line(`    profile      ${meta.profile}`);
    line(`    architecture ${meta.arch}`);
    line(`    format       ${meta.major}.${meta.minor}   protection v${(meta.domains ? 2 : 2)}`);
    line(`    optimize     ${opts.optimize !== false}`);
    line(`    permute      ${(meta.flags & V.FLAG_IDENTPERM) ? 'identity (dev)' : 'randomized'}`);
    line(`    seeds/perm   derived (not stored in payload)`);
    line('  protection knobs (global floor; directives override per-fn):');
    line(`    flatten CF   ${onoff(c.flatten)}`);
    line(`    bogus CF     ${c.bogus ? 'level ' + c.bogus : 'off'}`);
    line(`    split blocks ${onoff(c.split)}`);
    line(`    cipher rounds${' ' + (c.protLevel != null ? c.protLevel : 1)} per function`);
    line(`    conceal ints ${onoff(c.conceal)}`);
    line(`    fuse opcodes ${onoff(c.fuse)}`);
    line(`    encrypt str  ${c.encStr && c.encStr !== 'none' ? c.encStr + ' (' + (meta.encStrCount || 0) + ' literals)' : 'off'}`);
    line(`    rename all   ${meta.renameSymbols ? 'on (' + meta.renameCount + ' symbols)' : 'off'}`);
    line(`    signed       ${meta.signed}`);
    if (meta.dudFns) line(`    dead-code    ${meta.dudFns} decoy function(s)`);
    // per-function modifications / virtualization
    const withMods = (meta.modifications || []).filter((m) => m.level !== 'weak' || m.mods.length || m.async);
    if (withMods.length) {
      line('  functions (identity / level / modifications):');
      for (const m of withMods) {
        const tags = m.mods.length ? '  [' + m.mods.join(', ') + ']' : '';
        line(`    ${m.name.padEnd(18)} <${(m.identity || 'client').padEnd(8)}> ${m.level}${m.async ? ' async' : ''}${tags}`);
      }
    }
    line('  statistics:');
    const lv = { native: 0, weak: 0, medium: 0, heavy: 0 };
    for (const m of (meta.modifications || [])) lv[m.level] = (lv[m.level] || 0) + 1;
    const idc = { vm: 0, nativejs: 0, client: 0 };
    for (const m of (meta.modifications || [])) idc[m.identity] = (idc[m.identity] || 0) + 1;
    line(`    functions    ${meta.numFns} real${meta.dudFns ? ' + ' + meta.dudFns + ' decoy' : ''}`);
    line(`    identity     vm:${idc.vm || 0} nativejs:${idc.nativejs || 0} client:${idc.client || 0} deadcode:${(idc.deadcode || 0) + (meta.dudFns || 0)}`);
    line(`    protection   native:${lv.native || 0} weak:${lv.weak || 0} medium:${lv.medium || 0} heavy:${lv.heavy || 0}`);
    line(`    image        ${meta.imageSize} bytes`);
    line(`    checksum     0x${meta.checksum.toString(16)}  (+ ${meta.domains ? 4 : 1} integrity domains)`);
    line('');
    return;
  }

  console.error(`error: unknown command '${cmd}'`);
  usage();
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
