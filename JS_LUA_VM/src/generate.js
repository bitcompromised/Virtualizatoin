'use strict';
// High-level pipeline: source string -> protected VM source in a target language.

const { compile } = require('./compiler');
const { buildImage } = require('./protect');
const { emitJs } = require('./emit-js');
const { emitLua } = require('./emit-lua');
const { disassemble } = require('./disasm');
const { OP_NAME } = require('./opcodes');
const V = require('./version');

// A detailed, human-readable build summary written to <out>_summary.txt: the raw
// source, the symbol rename table, every function's scope (params/locals by
// name), the obfuscation passes applied and how many instructions they added,
// the post-protection disassembly, and overall statistics.
function buildSummary(program, source, cfg, meta, renameMap, mods, finalSource) {
  const L = [];
  const rule = (c) => c.repeat(64);
  L.push('vm-gen build summary'); L.push(rule('='));
  L.push('');
  L.push('## Configuration');
  L.push(`  target        ${meta.target || 'js'}`);
  L.push(`  profile       ${cfg.profile}`);
  L.push(`  architecture  ${cfg.arch}`);
  L.push(`  format        ${meta.major}.${meta.minor}   protection v${V.PROTECTION_VERSION}`);
  L.push(`  optimize      ${cfg.optimize}`);
  L.push(`  permute       ${(meta.flags & V.FLAG_IDENTPERM) ? 'identity (dev)' : 'randomized'}`);
  L.push(`  flatten CF    ${!!cfg.flatten}`);
  L.push(`  bogus CF      ${cfg.bogus ? 'level ' + cfg.bogus : 'off'}`);
  L.push(`  split blocks  ${!!cfg.split}`);
  L.push(`  cipher rounds ${cfg.protLevel != null ? cfg.protLevel : 1} per function`);
  L.push(`  fuse opcodes  ${!!cfg.fuse}`);
  L.push(`  conceal ints  ${cfg.conceal}`);
  L.push(`  encrypt str   ${cfg.encStr && cfg.encStr !== 'none' ? cfg.encStr + ' (' + (meta.encStrCount || 0) + ' literals reconstructed at runtime)' : 'off'}`);
  L.push(`  encrypt num   ${cfg.encNum ? 'on (' + (meta.encNumCount || 0) + ' integer literals -> XOR reconstruction)' : 'off'}`);
  L.push(`  dead-code     ${meta.dudFns || 0} decoy function(s)`);
  L.push(`  seeds/perm    derived (not stored in payload)`);
  L.push(`  rename all    ${meta.renameSymbols ? 'on' : 'off'}`);
  L.push(`  signed        ${meta.signed}`);
  L.push(`  limits        steps=${cfg.maxSteps} depth=${cfg.maxDepth} objects=${cfg.maxObjects} string=${cfg.maxString}`);
  L.push('');
  L.push('## Source (input)'); L.push(rule('-'));
  L.push(source.replace(/\s+$/, ''));
  L.push('');
  L.push('## Symbol rename table (original -> obfuscated)'); L.push(rule('-'));
  const rk = Object.keys(renameMap);
  if (rk.length === 0) L.push('  (renaming disabled)');
  for (const orig of rk) L.push(`  ${String(orig).padEnd(24)} -> ${renameMap[orig]}`);
  L.push('');
  L.push('## Functions'); L.push(rule('-'));
  program.functions.forEach((fn, i) => {
    const m = mods[i] || { name: fn.name, level: 'L' + fn.protLevel, mods: [], identity: 'client' };
    L.push(`#${i}  ${m.name}   <${m.identity}>   (compiled as: ${fn.name})`);
    L.push(`    identity ${m.identity} | params ${fn.nparams} | locals ${fn.nlocals} | level ${m.level}${fn.async ? ' | async' : ''}`);
    // scope: local variable names (slot -> source name)
    const names = [];
    for (let s = 0; s < fn.nlocals; s++) if (fn.localNames && fn.localNames[s] !== undefined) names.push(`[${s}] ${fn.localNames[s]}${s < fn.nparams ? ' (param)' : ''}`);
    L.push(`    scope: ${names.length ? names.join(', ') : '(none)'}`);
    if (fn.upvals && fn.upvals.length) L.push(`    upvalues: ${fn.upvals.map((u) => u.name).join(', ')}`);
    const added = (fn.finalInstrCount || 0) - (fn.origInstrCount || 0);
    if (m.mods && m.mods.length) L.push(`    obfuscation: ${m.mods.join(', ')}  (+${added} instructions added by passes)`);
    // post-protection disassembly (offsets already resolved)
    L.push('    bytecode:');
    let off = 0;
    for (const ins of fn.instrs) {
      const args = ins.args && ins.args.length ? '  ' + ins.args.join(', ') : '';
      L.push(`      ${String(off).padStart(4)}  ${OP_NAME[ins.op]}${args}`);
      off += 1 + (ins.args ? ins.args.reduce((a, x) => a + (x > 255 || x < 0 ? 2 : 1), 0) : 0);
    }
    L.push('');
  });
  L.push('## Constant pool'); L.push(rule('-'));
  program.consts.forEach((c, i) => L.push(`  [${i}] ${typeof c === 'string' ? JSON.stringify(c) : c}`));
  L.push('');
  L.push('## Added code (what protection generated)'); L.push(rule('-'));
  const addedByPass = program.functions.reduce((a, f) => a + ((f.finalInstrCount || 0) - (f.origInstrCount || 0)), 0);
  L.push(`  obfuscation passes   +${addedByPass} instructions total (flat/bogus/split/close-upvalue)`);
  L.push('');
  // Per-function: the concrete opcodes each pass ADDED, shown as a histogram of
  // (post-transform opcodes) minus (pre-transform opcodes). This is the result of
  // <@flat>/<@bogus>/<@split> on that function.
  let anyAdded = false;
  program.functions.forEach((fn, i) => {
    if (!fn.preTransformOps) return;
    const before = {}, after = {};
    for (const n of fn.preTransformOps) before[n] = (before[n] || 0) + 1;
    for (const ins of fn.instrs) { const n = OP_NAME[ins.op]; after[n] = (after[n] || 0) + 1; }
    const added = [];
    for (const n of Object.keys(after)) { const d = (after[n] || 0) - (before[n] || 0); if (d > 0) added.push(`${n} x${d}`); }
    const p = fn.prot || {};
    const passes = [p.flatten && 'flat', p.bogus && ('bogus:' + p.bogus), p.split && 'split'].filter(Boolean).join(', ');
    const m = (mods[i] || {}).name || fn.name;
    L.push(`  #${i} ${m}  [${passes}]  ${fn.preTransformOps.length} -> ${fn.instrs.length} instructions (+${fn.instrs.length - fn.preTransformOps.length})`);
    if (added.length) L.push(`      added opcodes: ${added.join(', ')}`);
    anyAdded = true;
  });
  if (!anyAdded) L.push('  (no control-flow passes active - enable <@flat>/<@bogus>/<@split> or --flatten/--bogus/--split)');
  L.push('');
  if (meta.encStrCount) {
    L.push(`  string encryption    ${meta.encStrCount} literal(s) rewritten into runtime reconstruction code`);
    L.push('                       (String.fromCharCode / Array.join expressions instead of plaintext)');
  }
  if (meta.dudFns) {
    L.push(`  decoy functions      ${meta.dudFns} inert "dud" function(s) appended to the datastream:`);
    L.push('                       - well-formed, permuted, RET-terminated bytecode (result of <@deadcode>/--dud)');
    L.push('                       - never referenced by any CALL/CLOSURE, so never run');
    L.push('                       - covered by the function-integrity domain like real code');
    // decoy "source": disassembly of each decoy's synthetic bytecode
    (meta.dudDisasm || []).forEach((d, di) => {
      L.push(`    decoy#${di} ${d.name}(${d.nparams} params, ${d.nlocals} locals, ${d.protLevel} cipher rounds):`);
      (d.ops || []).forEach((op) => L.push(`        ${op}`));
    });
  } else {
    L.push('  decoy functions      0 (enable with --dud or the aggressive profile)');
  }
  L.push(`  symbol renaming      ${meta.renameCount || 0} names -> opaque randoms`);
  L.push(`  VM randomization     internal VM identifiers randomized + minified per build`);
  L.push('');
  L.push('## Recognized bytecode patterns'); L.push(rule('-'));
  L.push('  Hot adjacent-opcode sequences (fusion / opcode-randomization candidates).');
  // known fixed superinstructions the fuser can collapse a bigram into
  const FUSIBLE = { 'LOAD ADD': 'LOADADD', 'LOAD SUB': 'LOADSUB', 'LOAD LT': 'LOADLT', 'PUSH_CONST ADD': 'CONSTADD' };
  const pats = analyzePatterns(program, 10);
  L.push(`  fusion: ${cfg.fuse ? 'ON (matching bigrams collapsed into superinstructions)' : 'off'}`);
  L.push('  top bigrams:');
  if (!pats.bigrams.length) L.push('    (none repeated)');
  for (const [k, c] of pats.bigrams) L.push(`    ${String(c).padStart(4)}x  ${k}${FUSIBLE[k] ? '   -> ' + FUSIBLE[k] : ''}`);
  L.push('  top trigrams:');
  if (!pats.trigrams.length) L.push('    (none repeated)');
  for (const [k, c] of pats.trigrams) L.push(`    ${String(c).padStart(4)}x  ${k}`);
  L.push('');
  L.push('## Statistics'); L.push(rule('-'));
  const totalInstr = program.functions.reduce((a, f) => a + f.instrs.length, 0);
  L.push(`  real functions      ${meta.numFns - (meta.dudFns || 0)}`);
  L.push(`  decoy functions     ${meta.dudFns || 0}`);
  L.push(`  total instructions  ${totalInstr}  (${addedByPass} added by obfuscation passes)`);
  L.push(`  constants           ${program.consts.length}`);
  L.push(`  image size          ${meta.imageSize} bytes`);
  L.push(`  checksum            0x${meta.checksum.toString(16)}  (+ 4 integrity domains)`);
  L.push('');
  return L.join('\n');
}

// Rename every compiled function and upvalue to an opaque random identifier, so
// the protected image never leaks original symbol names. Compiled calls use
// numeric indices, and (in cells mode) upvalues use slot indices, so renaming is
// purely cosmetic to the runtime -- but it strips a major analysis aid. `$main`
// is left recognizable only internally; its stored name is randomized too.
function randIdent(rng) {
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '_' + A[rng() % 52];
  const n = 6 + (rng() % 6);
  for (let i = 0; i < n; i++) s += (A + '0123456789')[rng() % 62];
  return s;
}
function renameCompiledNames(program, rng) {
  const renamed = {};
  for (const fn of program.functions) {
    const to = randIdent(rng);
    renamed[fn.name] = to;
    fn.name = to;
    if (Array.isArray(fn.upvals)) for (const u of fn.upvals) if (u.name) u.name = randIdent(rng);
    if (Array.isArray(fn.handlers)) for (const h of fn.handlers) if (h.catchName) h.catchName = randIdent(rng);
  }
  return renamed;
}

// Summarize per-function protection + modifications for the build console.
function collectModifications(program) {
  const LVL = ['native', 'weak', 'medium', 'heavy'];
  const mods = [];
  program.functions.forEach((fn, i) => {
    const p = fn.prot || {};
    const tags = [];
    if (p.flatten) tags.push('flat');
    if (p.bogus) tags.push('bogus:' + p.bogus);
    if (p.split) tags.push('split');
    if (p.deadcode) tags.push('deadcode:' + p.deadcode);
    if (p.controlFlow) tags.push('controlflow:' + p.controlFlow);
    // Function identity: how this function participates in the artifact.
    //   vm       - the top-level entry ($main): boots + drives the machine
    //   nativejs - <@native> annotated: emitted to run without virtualization
    //   client   - ordinary guest code, virtualized into bytecode
    //   deadcode - decoy/dud (added to the image, reported separately)
    const identity = fn.isDecoy ? 'deadcode' : (i === 0 ? 'vm' : (fn.protLevel === 0 ? 'nativejs' : 'client'));
    mods.push({ name: fn.name, level: LVL[fn.protLevel] || ('L' + fn.protLevel), async: !!fn.async, mods: tags, identity });
  });
  return mods;
}

// Bytecode pattern recognition: scan every function's instruction stream for the
// most frequent adjacent opcode sequences (bigrams + trigrams). These are the
// hot patterns a fuser would collapse into superinstructions, and they drive the
// per-build opcode variation (fusion + permutation + handler mutation). Returns
// the top patterns with their occurrence counts.
function analyzePatterns(program, topN) {
  const bi = new Map();
  const tri = new Map();
  for (const fn of program.functions) {
    const ops = fn.instrs.map((x) => OP_NAME[x.op]);
    for (let i = 0; i + 1 < ops.length; i++) {
      const k2 = ops[i] + ' ' + ops[i + 1];
      bi.set(k2, (bi.get(k2) || 0) + 1);
      if (i + 2 < ops.length) { const k3 = k2 + ' ' + ops[i + 2]; tri.set(k3, (tri.get(k3) || 0) + 1); }
    }
  }
  const top = (m) => [...m.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, topN || 12);
  return { bigrams: top(bi), trigrams: top(tri) };
}

// Resolve a build profile into a concrete configuration. Explicit options always
// override the profile's defaults, so `--profile performance --max-depth 100`
// works as expected.
function resolveConfig(options = {}) {
  const profile = (options.profile || 'balanced').toLowerCase();
  const base = V.PROFILE_CONFIG[profile];
  if (!base) throw new Error(`unknown profile '${profile}' (expected ${V.PROFILE_NAMES.join(', ')})`);
  const pick = (k) => (options[k] !== undefined ? options[k] : base[k]);
  return {
    profile,
    optimize: pick('optimize'),
    permute: pick('permute'),
    conceal: pick('conceal'),
    dud: pick('dud'),
    dudCount: options.dudCount,
    maxSteps: pick('maxSteps'),
    maxDepth: pick('maxDepth'),
    maxObjects: pick('maxObjects'),
    maxString: pick('maxString'),
    fuse: options.fuse !== undefined ? options.fuse : (base.fuse || false),
    arch: options.arch || base.arch,
    // Global protection floor (applied to every function; directives win on top).
    flatten: !!pick('flatten'),
    bogus: (pick('bogus') | 0),
    split: !!pick('split'),
    protLevel: (pick('protLevel') != null ? (pick('protLevel') | 0) : 1),
    encStr: pick('encStr') || 'none',
    encNum: !!pick('encNum'),
  };
}

function generate(source, options = {}) {
  const target = (options.target || 'js').toLowerCase();
  const cfg = resolveConfig(options);
  // String reconstruction relies on JS host methods (String.fromCharCode /
  // Array.join) that the Lua VM does not implement, so disable it for Lua. The
  // constant-pool cipher (and optional conceal) still hides strings on both.
  if ((target === 'lua') && cfg.encStr && cfg.encStr !== 'none') {
    if (options.encStr && options.encStr !== 'none' && !options.quiet) {
      console.error("vm-gen: note: --encstr is not supported for the lua target; ignoring (pool cipher still applies)");
    }
    cfg.encStr = 'none';
  }
  const globalProt = { flatten: cfg.flatten, bogus: cfg.bogus, split: cfg.split, protLevel: cfg.protLevel };
  const program = compile(source, {
    optimize: cfg.optimize, resolveImport: options.resolveImport, fuse: cfg.fuse, seed: options.seed,
    globalProt, encStr: cfg.encStr, encNum: cfg.encNum, perFnProt: options.perFnProt,
  });
  const limited = cfg.maxSteps > 0 || cfg.maxDepth > 0 || cfg.maxObjects > 0 || cfg.maxString > 0;

  // Per-function modification report (before names are randomized so it reads).
  const modifications = collectModifications(program);
  // Rename all compiled symbols by default (disable only in development, or via
  // renameSymbols:false). Uses a seeded RNG so builds stay reproducible.
  const renameSymbols = options.renameSymbols !== undefined ? options.renameSymbols : (cfg.profile !== 'development');
  let renameCount = 0;
  let renameMap = {};
  if (renameSymbols) {
    let s = (options.seed !== undefined ? options.seed : 0x1234567) >>> 0; s = (s ^ 0xabcdef) >>> 0;
    const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
    renameMap = renameCompiledNames(program, rng);
    renameCount = program.functions.length;
  }

  const { image, meta } = buildImage(program, {
    seed: options.seed,
    profile: cfg.profile,
    arch: cfg.arch,
    optimized: cfg.optimize,
    permute: cfg.permute,
    conceal: cfg.conceal,
    dud: cfg.dud,
    dudCount: cfg.dudCount,
    limited,
    signKey: options.sign,
  });

  const emitOpts = Object.assign({}, options, { maxSteps: cfg.maxSteps, maxDepth: cfg.maxDepth, maxObjects: cfg.maxObjects, maxString: cfg.maxString, salt: meta.salt, arch: cfg.arch });
  let out;
  if (target === 'js' || target === 'javascript') out = emitJs(image, emitOpts);
  else if (target === 'lua') out = emitLua(image, emitOpts);
  else throw new Error(`Unknown target '${target}' (expected js or lua)`);

  meta.modifications = modifications;
  meta.renameSymbols = renameSymbols;
  meta.renameCount = renameCount;
  meta.target = target;
  meta.cfg = cfg;                       // effective settings (for the build report)
  meta.encStrCount = program.encStrCount || 0;
  meta.encNumCount = program.encNumCount || 0;
  meta.renameMap = renameMap;           // original -> obfuscated symbol names (added names)
  meta.consts = program.consts;         // constant pool (values baked into the image)
  meta.patterns = analyzePatterns(program, 10); // recognized hot opcode sequences
  meta.summary = buildSummary(program, source, cfg, meta, renameMap, modifications, out);
  return { output: out, program, image, meta, config: cfg };
}

// Analyze source into a per-function scope listing for the UI/API: every
// function with its index (stable for a given `optimize` setting), original
// name, parameters, locals and captured upvalues by name, plus any inline
// protection directives already present. Build MUST use the same `optimize`
// value for the indices to line up with per-function overrides.
function analyze(source, options = {}) {
  const optimize = options.optimize !== undefined ? options.optimize : false;
  const program = compile(source, { optimize, resolveImport: options.resolveImport });
  return {
    optimize,
    functions: program.functions.map((fn, i) => {
      const names = fn.localNames || [];
      const params = [];
      const locals = [];
      for (let s = 0; s < fn.nlocals; s++) {
        const nm = names[s];
        if (nm === undefined) continue;
        (s < fn.nparams ? params : locals).push(nm);
      }
      const identity = fn.isDecoy ? 'deadcode' : (i === 0 ? 'vm' : (fn.protLevel === 0 ? 'nativejs' : 'client'));
      return {
        index: i,
        name: fn.name === '$main' ? '(top-level)' : fn.name,
        isMain: fn.name === '$main',
        parent: (fn.parent != null) ? fn.parent : -1,
        identity,
        params, locals,
        upvalues: (fn.upvals || []).map((u) => u.name).filter(Boolean),
        async: !!fn.async, generator: !!fn.generator,
        directives: fn.prot || null,
      };
    }),
  };
}

module.exports = { generate, compile, buildImage, disassemble, resolveConfig, analyze, analyzePatterns };
