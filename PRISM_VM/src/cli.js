#!/usr/bin/env node
'use strict';
// Prism CLI -- a thin client over the api. Commands mirror the API 1:1.
//   prism run     <file>            compile + run on the interpreter (oracle)
//   prism build   <file> [-o out]   emit a standalone JS VM
//   prism analyze <file>            print the function/scope report
//   prism version
const fs = require('fs');
const path = require('path');
const api = require('./api');
const V = require('./core/version');
const { disassemble } = require('./core/disasm');
const { toImage } = require('./api');

// Load prism.config.js (from --config or the cwd) as build defaults; explicit
// CLI flags override it.
function loadConfig(opts) {
  let cfg = {};
  const file = opts.config || (fs.existsSync(path.resolve('prism.config.js')) ? 'prism.config.js' : null);
  if (file) { try { cfg = require(path.resolve(file)); } catch (e) { console.error('prism: config error: ' + e.message); } }
  return Object.assign({}, cfg, opts); // opts win
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = { _: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '-t' || a === '--target') opts.target = argv[++i];
    else if (a === '-m' || a === '--machine') opts.machine = argv[++i];
    else if (a === '--encrypted') opts.encrypted = true;
    else if (a === '--permute') opts.permute = true;
    else if (a === '--sign') { opts.protect = opts.protect || {}; opts.protect.sign = true; }
    else if (a === '--cipher') { opts.protect = opts.protect || {}; opts.protect.cipher = argv[++i]; }
    else if (a === '--integrity') { opts.protect = opts.protect || {}; opts.protect.integrity = argv[++i]; }
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--no-optimize') opts.optimize = false;
    else if (a === '--bogus') { opts.protect = opts.protect || {}; opts.protect.bogus = parseInt(argv[++i], 10); }
    else if (a === '--decoys') { opts.protect = opts.protect || {}; opts.protect.decoys = parseInt(argv[++i], 10); }
    else opts._.push(a);
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') { console.log('prism ' + V.PRISM_VERSION); return; }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('prism <run|build|analyze|disasm|version> <file> [options]\n'
      + '  run <file>              compile + execute on the interpreter\n'
      + '  build <file> [-o out]   emit a standalone VM\n'
      + '  analyze <file>          function / scope report\n'
      + '  disasm <file>           print the bytecode listing\n'
      + 'options: -t js|lua|py  -m stack|register  --encrypted  --permute  --sign  --bogus N\n'
      + '         --decoys N  --cipher none|xor  --integrity fnv1a|fnv1a-mac  --seed N\n'
      + '         --no-optimize  --config <file>  -o <out>\n'
      + 'inline:  <@protect encrypt permute sign decoys=N bogus=N backend=js|lua|py>');
    return;
  }
  const file = opts._[0];
  if (!file) { console.error('error: missing source file'); process.exit(2); }
  const source = fs.readFileSync(file, 'utf8');

  if (cmd === 'disasm') { console.log(disassemble(toImage(source, loadConfig(opts)))); return; }
  if (cmd === 'run') { for (const line of api.run(source, loadConfig(opts)).output) process.stdout.write(line + '\n'); return; }
  if (cmd === 'analyze') {
    const r = api.analyze(source);
    for (const f of r.functions) {
      console.log(`${f.isMain ? '*' : ' '} ${f.name}`
        + (f.params.length ? `  params(${f.params.join(', ')})` : '')
        + (f.locals.length ? `  locals(${f.locals.join(', ')})` : ''));
    }
    return;
  }
  if (cmd === 'build') {
    const { code, meta } = api.build(source, loadConfig(opts));
    const ext = meta.target === 'lua' ? '.prism.lua' : (meta.target === 'py' ? '.prism.py' : '.prism.js');
    const out = opts.out || (file.replace(/\.[^.]+$/, '') + ext);
    fs.writeFileSync(out, code);
    const prot = meta.target === 'js' ? `, ${meta.imageBytes}B image${meta.protected.constCipher ? ', const-cipher' : ''}${meta.protected.permuted ? ', permuted' : ''}${meta.protected.encryptedState ? ', enc-state' : ''}${meta.decoys ? ', ' + meta.decoys + ' decoys' : ''}, ${meta.protected.signed ? 'signed' : 'integrity'}` : (meta.decoys ? `, ${meta.decoys} decoys` : '');
    console.error(`prism: wrote ${path.relative(process.cwd(), out)}  [${meta.target}/${meta.machine}, format ${meta.imageFormat}, ${meta.numFns} fns${prot}]`);
    return;
  }
  console.error(`error: unknown command '${cmd}'`); process.exit(2);
}
main();
