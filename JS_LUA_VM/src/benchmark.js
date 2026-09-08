'use strict';
// Profiling / benchmarking for a source program.
//
//   vm-gen benchmark app.vgs
//
// Measures compile time, artifact size, startup + execution time, memory use,
// instruction count, VM dispatch count and constant-decode count. Dispatch and
// instruction counts come from the reference interpreter, which executes the
// exact same canonical bytecode the protected VM runs, so they match the VM.

const { compile } = require('./compiler');
const { generate, resolveConfig } = require('./generate');
const { interpret } = require('./interp');

const now = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

// Run a generated standalone JS module with stdout suppressed, returning elapsed ms.
function timeRun(jsSource) {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  process.stdout.write = () => true;
  console.log = () => {};
  console.error = () => {};
  process.exit = () => { throw new Error('__exit__'); };
  const t = now();
  try {
    new Function('module', 'exports', 'require', 'process', 'console', 'Buffer', jsSource)(
      { exports: {} }, {}, require, process, console, Buffer);
  } catch (_) { /* controlled failure / limit */ }
  const dt = ms(t, now());
  process.stdout.write = origWrite; console.log = origLog; console.error = origErr; process.exit = origExit;
  return dt;
}

function benchmark(source, opts = {}) {
  const seed = opts.seed;
  const runs = opts.runs || 7;
  const cfg = resolveConfig(opts);

  // compile time (per resolved profile)
  let t = now();
  const program = compile(source, { optimize: cfg.optimize, resolveImport: opts.resolveImport });
  const compileMs = ms(t, now());

  // static program stats
  const instrCount = program.functions.reduce((a, f) => a + f.instrs.length, 0);
  const constCount = program.consts.length;
  const fnCount = program.functions.length;

  // dispatch count = instructions actually executed (reference interpreter)
  const interp = interpret(program);

  // artifact sizes + build time
  t = now();
  const js = generate(source, { target: 'js', banner: false, seed, profile: cfg.profile });
  const buildJsMs = ms(t, now());
  t = now();
  const lua = generate(source, { target: 'lua', banner: false, seed, profile: cfg.profile });
  const buildLuaMs = ms(t, now());

  // execution time of the JS artifact: load (decrypt + verify) + run, best-of-N
  let best = Infinity, sum = 0;
  const memBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < runs; i++) {
    const dt = timeRun(js.output);
    best = Math.min(best, dt);
    sum += dt;
  }
  const memAfter = process.memoryUsage().heapUsed;

  return {
    profile: cfg.profile,
    optimized: cfg.optimize,
    compileMs,
    buildJsMs,
    buildLuaMs,
    jsArtifactBytes: Buffer.byteLength(js.output, 'utf8'),
    luaArtifactBytes: Buffer.byteLength(lua.output, 'utf8'),
    imageBytes: js.meta.imageSize,
    fnCount,
    instrCount,        // number of distinct instructions in the program
    dispatchCount: interp.steps, // instructions executed at run time
    constCount,        // constant-pool entries (constant-decode count)
    execBestMs: best,
    execAvgMs: sum / runs,
    heapDeltaBytes: Math.max(0, memAfter - memBefore),
    outputLines: interp.output.length,
  };
}

// Render a benchmark result as an aligned text report.
function formatReport(file, r) {
  const rows = [
    ['profile', r.profile + (r.optimized ? ' (optimized)' : '')],
    ['compile time', r.compileMs.toFixed(3) + ' ms'],
    ['build time (js)', r.buildJsMs.toFixed(3) + ' ms'],
    ['build time (lua)', r.buildLuaMs.toFixed(3) + ' ms'],
    ['image size', r.imageBytes + ' B'],
    ['artifact size (js)', r.jsArtifactBytes + ' B'],
    ['artifact size (lua)', r.luaArtifactBytes + ' B'],
    ['functions', String(r.fnCount)],
    ['instructions (static)', String(r.instrCount)],
    ['dispatch count (run)', String(r.dispatchCount)],
    ['constant decodes', String(r.constCount)],
    ['startup+exec (best)', r.execBestMs.toFixed(3) + ' ms'],
    ['startup+exec (avg)', r.execAvgMs.toFixed(3) + ' ms'],
    ['heap delta', (r.heapDeltaBytes / 1024).toFixed(1) + ' KiB'],
    ['output lines', String(r.outputLines)],
  ];
  const w = Math.max(...rows.map((x) => x[0].length));
  const lines = [`vm-gen benchmark  ${file}`, '-'.repeat(30)];
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(w)}  ${v}`);
  return lines.join('\n');
}

module.exports = { benchmark, formatReport };
