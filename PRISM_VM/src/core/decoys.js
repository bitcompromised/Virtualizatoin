'use strict';
// Decoy functions -- a `kind:'decoy'` plugin, consumed by the compiler. A decoy
// is a plausible, well-formed function appended to the image's function table
// that NO real instruction ever targets (the compiler never emits CALL/CLOSURE
// to a decoy's index). Static readers and disassemblers see extra code paths;
// the program never runs them. Because they are unreachable, decoys are
// output-neutral BY CONSTRUCTION -- the differential conformance oracle proves it
// on every backend (interpreter, register machine, JS VM, Lua VM).
//
// A decoy plugin is `{ kind:'decoy', name, generate(fn, ctx) }` where `fn` is a
// fresh compiler FnScope (same emit/label/here/slot API the real compiler uses,
// so operand widths and jump offsets are resolved by the exact same finisher) and
// ctx = { rng, constId, OP }. The built-in below scales body size and branchiness
// with `strength` (1-3), mirroring vm-gen's `<@decoy x>`.

const { definePlugin } = require('./plugin');

function makeArithDecoy(strength) {
  const lv = Math.max(1, Math.min(3, strength | 0)) || 1;
  return definePlugin({
    kind: 'decoy', name: 'arith-decoy',
    generate(fn, ctx) {
      const rng = ctx.rng, OP = ctx.OP;
      const nloc = 2 + (rng() % 3);
      const local = (k) => fn.slot('d' + (k % nloc), true);
      let height = 0;
      const push = () => {
        const r = rng() % 4;
        if (r === 0) fn.emit(OP.PUSH_CONST, ctx.constId(rng() % 997));
        else if (r === 1) fn.emit(OP.LOAD, local(rng()));
        else if (r === 2) fn.emit(OP.PUSH_TRUE);
        else fn.emit(OP.PUSH_NULL);
        height++;
      };
      // seed a few locals so LOADs reference real slots
      for (let k = 0; k < nloc; k++) { fn.emit(OP.PUSH_CONST, ctx.constId(rng() % 997)); fn.emit(OP.STORE, local(k)); }
      const BIN = [OP.ADD, OP.SUB, OP.MUL, OP.MOD, OP.LT, OP.EQ, OP.GT];
      const steps = 6 + (rng() % (6 * lv));
      for (let s = 0; s < steps; s++) {
        if (height >= 2 && rng() % 2 === 0) { fn.emit(BIN[rng() % BIN.length]); height--; }
        else if (height >= 1 && rng() % 3 === 0) { fn.emit(OP.STORE, local(rng())); height--; }
        else push();
      }
      // optional bogus branch -- offsets resolved by the shared finisher, so the
      // decoy disassembles as real control flow even though it never executes.
      if (lv >= 2) {
        if (height < 1) push();
        const skip = fn.label();
        fn.emit(OP.JZ, skip); height--;
        push(); fn.emit(OP.POP); height--;
        fn.here(skip);
      }
      if (height < 1) push();
      fn.emit(OP.RET);
    },
  });
}

module.exports = { makeArithDecoy };
