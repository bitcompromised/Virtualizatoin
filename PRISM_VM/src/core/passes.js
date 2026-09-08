'use strict';
// The pass pipeline. Optimization and obfuscation are the SAME kind of thing --
// an IR->IR transform over a function's instruction list -- so they share one
// scheduler instead of living in separate, order-fragile code paths. Every pass
// is a plugin (kind:'pass'); the built-ins below use the exact same API a
// third-party pass would.
//
// The IR here is a function's instruction list, where jump targets are LABEL
// MARKER pseudo-instructions referenced by identity -- so a pass can splice
// instructions freely without breaking control flow (offsets are resolved once,
// at the end, by walking the final list). This is what makes obfuscation passes
// safe by construction.

const { definePlugin } = require('./plugin');
const { OP } = require('./spec');

const LBL = -1; // pseudo-op: a jump-target marker; width 0, never emitted

// Pushes with no side effects -- safe to cancel against a following POP.
const PURE_PUSH = new Set([OP.PUSH_CONST, OP.PUSH_TRUE, OP.PUSH_FALSE, OP.PUSH_NULL, OP.DUP, OP.LOAD]);

// ---- optimization: dead stack-op elimination ----
// Removes [pure-push][POP] pairs. A jump can only land on a LABEL marker, never
// on a raw instruction, so a consecutive push/pop with no marker between them is
// unreachable-from-elsewhere and always safe to drop.
const peepholeClean = definePlugin({
  kind: 'pass', name: 'peephole-clean', stage: 'optimize',
  run(fn) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < fn.instrs.length - 1; i++) {
        const a = fn.instrs[i], b = fn.instrs[i + 1];
        if (a.op !== LBL && b.op === OP.POP && PURE_PUSH.has(a.op)) {
          fn.instrs.splice(i, 2); changed = true; i = Math.max(-1, i - 2);
        }
      }
    }
  },
});

// ---- obfuscation: bogus stack churn ----
// Inserts net-zero (PUSH_CONST k; POP) pairs at random points. The pair leaves
// the stack exactly as it found it and touches no control flow, so it is
// semantics-preserving wherever it lands -- the differential conformance gate
// proves it. `level` (1-3) scales density.
function bogusStack(level) {
  const lv = Math.max(1, Math.min(3, level | 0));
  return definePlugin({
    kind: 'pass', name: 'bogus-stack', stage: 'obfuscate',
    run(fn, ctx) {
      const rng = ctx.rng;
      const out = [];
      for (let i = 0; i < fn.instrs.length; i++) {
        out.push(fn.instrs[i]);
        if (fn.instrs[i].op !== LBL && (rng() % (5 - lv)) === 0) {
          out.push({ op: OP.PUSH_CONST, args: [ctx.constId(rng() % 1000)] });
          out.push({ op: OP.POP, args: [] });
        }
      }
      fn.instrs = out;
    },
  });
}

// Order passes by stage, then run each over the function IR.
const STAGE_ORDER = { optimize: 0, obfuscate: 1, lower: 2 };
function runPipeline(fn, passes, ctx) {
  const rank = (s) => (STAGE_ORDER[s] === undefined ? 9 : STAGE_ORDER[s]);
  const ordered = passes.slice().sort((a, b) => rank(a.stage) - rank(b.stage));
  for (const p of ordered) p.run(fn, ctx);
}

module.exports = { LBL, peepholeClean, bogusStack, runPipeline };
