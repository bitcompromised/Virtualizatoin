'use strict';
// Phase-4 control-flow obfuscation passes, applied per function inside the
// compiler's finishFn -- BEFORE byte offsets are resolved, so they operate on an
// instruction array whose jump operands are still label objects `{pos: index}`.
// Every pass is semantics-preserving: the real execution path is unchanged; only
// bogus / reordered / flattened structure is added around it.
//
//   <@bogus>  -> opaque predicates, dead states, unreachable code clones
//   <@split>  -> basic-block splitting (fragment straight-line runs with jumps)
//   <@flat>   -> control-flow flattening (dispatcher over a state variable)

const { OP } = require('./opcodes');

// Remap every unique label object's `.pos` from an old instruction index to a
// new one after instructions have been inserted/reordered.
function remapLabels(instrs, map) {
  const seen = new Set();
  for (const ins of instrs) {
    for (const a of ins.args) {
      if (a && typeof a === 'object' && 'pos' in a && !seen.has(a)) { a.pos = map[a.pos]; seen.add(a); }
    }
  }
}

// Is this opcode a jump whose operand is a label (control-flow edge)?
function isJump(op) { return op === OP.JMP || op === OP.JZ || op === OP.JNZ; }
// An opcode that ends a straight-line run (control leaves sequentially here).
function isTerminator(op) { return op === OP.RET || op === OP.HALT || op === OP.JMP || op === OP.THROW; }

// ---- bogus control flow ----
// Insert benign, unreachable "dead-state" clones after terminators, plus an
// arithmetic opaque predicate at entry that always falls through to real code.
function insertBogus(instrs, level, rng) {
  const deadOps = [OP.PUSH_NULL, OP.PUSH_TRUE, OP.PUSH_FALSE, OP.DUP, OP.POP];
  const deadInstr = () => {
    const op = deadOps[rng() % deadOps.length];
    return { op, args: [] };
  };
  const out = [];
  const map = new Array(instrs.length + 1);
  for (let i = 0; i < instrs.length; i++) {
    map[i] = out.length;
    out.push(instrs[i]);
    // after a terminator the fall-through is unreachable: clone some dead code
    if (isTerminator(instrs[i].op) && (rng() % 3) !== 0) {
      const n = 1 + (rng() % (level + 1));
      for (let j = 0; j < n; j++) out.push(deadInstr());
    }
  }
  map[instrs.length] = out.length;
  remapLabels(out, map);
  return out;
}

// ---- basic-block splitting ----
// Fragment straight-line runs by inserting an unconditional jump to the very next
// instruction at random mid-run points. Each jump creates a fresh basic-block
// boundary, breaking long linear sequences into small pieces, while control flow
// stays provably identical (the jump always lands on the instruction it precedes).
// All jump targets are expressed as OLD instruction indices and remapped once.
function splitBlocks(instrs, rng) {
  const targets = new Set();
  for (const ins of instrs) for (const a of ins.args) if (a && typeof a === 'object' && 'pos' in a) targets.add(a.pos);

  const out = [];
  const map = new Array(instrs.length + 1);
  for (let i = 0; i < instrs.length; i++) {
    map[i] = out.length; // old index i -> position of instrs[i] in `out`
    const cur = instrs[i];
    out.push(cur);
    const next = i + 1;
    const canSplit = next < instrs.length
      && !isTerminator(cur.op) && !isJump(cur.op)
      && !targets.has(next)     // do not split before an existing jump target
      && (rng() % 3 === 0);
    if (canSplit) {
      // jump forward to the next instruction (label points at old index `next`,
      // which map remaps to just after this inserted JMP).
      out.push({ op: OP.JMP, args: [{ pos: next }] });
    }
  }
  map[instrs.length] = out.length;
  remapLabels(out, map);
  return out;
}

// ---- control-flow flattening ----
// Break the function into basic blocks, make every fall-through edge explicit
// with an unconditional jump, then emit the blocks in a random order. The linear
// layout no longer reflects execution order at all (it is driven entirely by the
// jump edges), while behavior is identical.
function flattenBlocks(instrs, rng) {
  if (instrs.length < 2) return instrs;
  // 1. leaders: block-start indices (entry, jump targets, instr after any jump).
  const leaders = new Set([0]);
  for (let i = 0; i < instrs.length; i++) {
    for (const a of instrs[i].args) if (a && typeof a === 'object' && 'pos' in a) leaders.add(a.pos);
    if (isJump(instrs[i].op) || instrs[i].op === OP.RET || instrs[i].op === OP.HALT || instrs[i].op === OP.THROW) {
      if (i + 1 < instrs.length) leaders.add(i + 1);
    }
  }
  const starts = Array.from(leaders).filter((x) => x < instrs.length).sort((a, b) => a - b);
  // 2. build blocks [start, end)
  const blocks = [];
  for (let b = 0; b < starts.length; b++) {
    const s = starts[b];
    const e = b + 1 < starts.length ? starts[b + 1] : instrs.length;
    blocks.push({ start: s, end: e });
  }
  // 3. shuffle block order (keep block 0 -- the entry -- first so execution starts right)
  const order = blocks.map((_, i) => i);
  for (let i = order.length - 1; i > 1; i--) { const j = 1 + (rng() % i); const t = order[i]; order[i] = order[j]; order[j] = t; }
  // 4. emit blocks in the shuffled order, adding explicit fall-through jumps.
  const out = [];
  const map = new Array(instrs.length + 1);
  for (const bi of order) {
    const blk = blocks[bi];
    for (let i = blk.start; i < blk.end; i++) { map[i] = out.length; out.push(instrs[i]); }
    const last = instrs[blk.end - 1];
    const fallsThrough = !(last.op === OP.RET || last.op === OP.HALT || last.op === OP.JMP || last.op === OP.THROW);
    if (fallsThrough && blk.end < instrs.length) out.push({ op: OP.JMP, args: [{ pos: blk.end }] });
  }
  map[instrs.length] = out.length;
  remapLabels(out, map);
  return out;
}

function applyTransforms(instrs, prot, rng) {
  if (!prot) return instrs;
  let out = instrs;
  if (prot.flatten) out = flattenBlocks(out, rng);
  if (prot.split) out = splitBlocks(out, rng);
  if (prot.bogus) out = insertBogus(out, prot.bogus, rng);
  return out;
}

module.exports = { applyTransforms, insertBogus, splitBlocks, remapLabels };
