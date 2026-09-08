'use strict';
// Known-good artifact regression check.
//
//   node test/known-good.js              verify current builds match the golden file
//   UPDATE_GOLDEN=1 node test/known-good.js   regenerate test/known-good.json
//
// Builds a fixed matrix of (program x target x profile) with fixed seeds and
// compares a SHA-256 of each emitted artifact against a stored golden hash. Any
// unintended change to the compiler, optimizer, protector or emitters -- i.e. a
// change in the exact bytes we ship -- shows up here immediately as a mismatch.
// A deliberate change is recorded by re-running with UPDATE_GOLDEN=1.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generate } = require('../src/generate');

const GOLDEN = path.join(__dirname, 'known-good.json');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Fixed, deterministic build matrix. Seeds are pinned so output is reproducible.
const PROGRAMS = {
  hello: 'print "hello, world!"; print 6 + 8;',
  fib: 'fn fib(n){ if(n<2){return n;} return fib(n-1)+fib(n-2); } let i=0; while(i<=6){ print fib(i); i=i+1; }',
  fold: 'let k=10; print 2+3*4; print k*2+1;',
  loops: 'let t=0; for(let i=0;i<8;i=i+1){ if(i==5){break;} t+=i; } print t; print t>10?"big":"small";',
};
const TARGETS = ['js', 'lua'];
const PROFILES = ['development', 'balanced', 'aggressive', 'performance'];
const SEED = 20260903;

function buildMatrix() {
  const out = {};
  for (const [name, src] of Object.entries(PROGRAMS)) {
    for (const target of TARGETS) {
      for (const profile of PROFILES) {
        const key = `${name}.${target}.${profile}`;
        const { output } = generate(src, { target, profile, seed: SEED, banner: false });
        out[key] = sha256(output);
      }
    }
  }
  return out;
}

const current = buildMatrix();

if (process.env.UPDATE_GOLDEN) {
  fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + '\n');
  console.log(`updated ${path.relative(process.cwd(), GOLDEN)} (${Object.keys(current).length} artifacts)`);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN)) {
  console.error('no golden file; run: UPDATE_GOLDEN=1 node test/known-good.js');
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
let pass = 0, fail = 0;
const keys = new Set([...Object.keys(golden), ...Object.keys(current)]);
for (const k of [...keys].sort()) {
  if (golden[k] === current[k]) { pass++; }
  else {
    fail++;
    console.log(`  MISMATCH ${k}`);
    console.log(`    golden : ${golden[k] || '(missing)'}`);
    console.log(`    current: ${current[k] || '(missing)'}`);
  }
}
console.log(`\nknown-good: ${pass} matched, ${fail} changed`);
if (fail) console.log('If this change is intentional: UPDATE_GOLDEN=1 node test/known-good.js');
process.exit(fail ? 1 : 0);
