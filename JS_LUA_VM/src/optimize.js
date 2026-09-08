'use strict';
// Compile-time optimizer -- pure AST -> AST transforms applied BEFORE codegen.
//
// GUARANTEE: every transform here is behavior-preserving. Protection must never
// become part of language semantics, and optimization must never change what a
// program prints or returns. The transforms are validated in the test suite by
// comparing the reference interpreter's output with and without optimization.
//
// Passes (run to a fixpoint):
//   * constant folding             2 + 3 * 4          -> 14
//   * algebraic / logical folding  false && f()       -> false   (short-circuit)
//   * branch pruning               if (true) A else B -> A
//   * constant propagation         let k = 5; k + 1   -> 6       (single-assign)
//   * dead-code elimination        code after return/break/continue is dropped
//
// Folding mirrors the VM's runtime value semantics exactly. Where JS and Lua
// number semantics could diverge (negative %, out-of-range bit ops) the
// operation is intentionally left un-folded so both back-ends keep producing
// bit-identical results.

const LIT = new Set(['Num', 'Str', 'Bool', 'Null']);
const isLit = (n) => !!n && LIT.has(n.type);
function litVal(n) {
  switch (n.type) {
    case 'Num': return n.value;
    case 'Str': return n.value;
    case 'Bool': return n.value;
    case 'Null': return null;
    default: throw new Error('not a literal');
  }
}
function mkLit(v) {
  if (v === null) return { type: 'Null' };
  if (typeof v === 'boolean') return { type: 'Bool', value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { type: 'Num', value: v } : null;
  if (typeof v === 'string') return { type: 'Str', value: v };
  return null; // arrays / non-representable values are never folded
}

// ---- value helpers mirroring the VM ----
function toStr(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  return String(v);
}
function truthy(v) { return !(v === null || v === false || v === 0 || v === ''); }
const isInt = (n) => typeof n === 'number' && Number.isInteger(n);
const u31 = (n) => isInt(n) && n >= 0 && n < 0x80000000;

// Fold a binary op over two constant JS values. Returns the result value, or
// the symbol UNSAFE to signal "leave this expression alone".
const UNSAFE = Symbol('unsafe');
function foldBin(op, x, y) {
  const nums = typeof x === 'number' && typeof y === 'number';
  const strs = typeof x === 'string' && typeof y === 'string';
  switch (op) {
    case '+': return nums ? x + y : toStr(x) + toStr(y);
    case '-': return nums ? x - y : UNSAFE;
    case '*': return nums ? x * y : UNSAFE;
    case '/': return nums && y !== 0 ? x / y : UNSAFE;
    case '%': return nums && x >= 0 && y > 0 ? x % y : UNSAFE; // avoid JS/Lua sign divergence
    case '==': return x === y;
    case '!=': return x !== y;
    case '<': return (nums || strs) ? x < y : UNSAFE;
    case '>': return (nums || strs) ? x > y : UNSAFE;
    case '<=': return (nums || strs) ? x <= y : UNSAFE;
    case '>=': return (nums || strs) ? x >= y : UNSAFE;
    case '&': return u31(x) && u31(y) ? (x & y) >>> 0 : UNSAFE;
    case '|': return u31(x) && u31(y) ? (x | y) >>> 0 : UNSAFE;
    case '^': return u31(x) && u31(y) ? (x ^ y) >>> 0 : UNSAFE;
    case '<<': return u31(x) && isInt(y) && y >= 0 && y < 31 ? (x << y) >>> 0 : UNSAFE;
    case '>>': return u31(x) && isInt(y) && y >= 0 && y < 31 ? (x >>> y) >>> 0 : UNSAFE;
    default: return UNSAFE;
  }
}

// ---- expression optimization ----
function optExpr(e) {
  if (!e) return e; // uninitialized `let` has a null value
  switch (e.type) {
    case 'Unary': {
      const arg = optExpr(e.arg);
      if (isLit(arg)) {
        const v = litVal(arg);
        if (e.op === '-' && typeof v === 'number') { const l = mkLit(-v); if (l) return l; }
        if (e.op === '!') return mkLit(!truthy(v));
      }
      return { type: 'Unary', op: e.op, arg };
    }
    case 'Binary': {
      const left = optExpr(e.left);
      const right = optExpr(e.right);
      if (e.op === '&&' || e.op === '||') return optLogical(e.op, left, right);
      if (isLit(left) && isLit(right)) {
        const r = foldBin(e.op, litVal(left), litVal(right));
        if (r !== UNSAFE) { const lit = mkLit(r); if (lit) return lit; }
      }
      return { type: 'Binary', op: e.op, left, right };
    }
    case 'Ternary': {
      const test = optExpr(e.test);
      const cons = optExpr(e.cons);
      const alt = optExpr(e.alt);
      if (isLit(test)) return truthy(litVal(test)) ? cons : alt;
      return { type: 'Ternary', test, cons, alt };
    }
    case 'Call': return { type: 'Call', callee: optExpr(e.callee), args: e.args.map(optExpr) };
    case 'Index': return { type: 'Index', object: optExpr(e.object), index: optExpr(e.index) };
    case 'Member': return { type: 'Member', object: optExpr(e.object), property: e.property };
    case 'Array': return { type: 'Array', elements: e.elements.map(optExpr) };
    case 'Object': return { type: 'Object', props: e.props.map((p) => (
      p.spread ? { spread: optExpr(p.spread) }
        : { key: p.key, kind: p.kind, computed: p.computed, keyNode: p.keyNode ? optExpr(p.keyNode) : undefined, value: optExpr(p.value) }
    )) };
    case 'FnExpr': return { type: 'FnExpr', name: e.name, params: e.params, body: { type: 'Block', body: optBody(e.body.body, e.params) }, async: e.async, generator: e.generator, protLevel: e.protLevel, prot: e.prot, restParam: e.restParam };
    default: return e; // literals and identifiers pass through
  }
}

// && / || fold to the VM's boolean result, but only where short-circuit makes
// dropping the other operand safe (constant left) or both operands are constant.
function optLogical(op, left, right) {
  const node = { type: 'Binary', op, left, right };
  if (isLit(left)) {
    const l = truthy(litVal(left));
    if (op === '&&') {
      if (!l) return mkLit(false);                        // false && R  -> false
      if (isLit(right)) return mkLit(truthy(litVal(right)));
    } else { // ||
      if (l) return mkLit(true);                          // true  || R  -> true
      if (isLit(right)) return mkLit(truthy(litVal(right)));
    }
  }
  return node;
}

// ---- statement optimization ----
// Returns an array of replacement statements (0, 1, or several).
function optStmt(s) {
  switch (s.type) {
    case 'Let': return [{ type: 'Let', name: s.name, value: optExpr(s.value) }];
    case 'Assign': return [{ type: 'Assign', target: optExpr(s.target), value: optExpr(s.value) }];
    case 'Print': return [{ type: 'Print', value: optExpr(s.value) }];
    case 'ExprStmt': return [{ type: 'ExprStmt', expr: optExpr(s.expr) }];
    case 'Return': return [{ type: 'Return', value: s.value ? optExpr(s.value) : null }];
    case 'Throw': return [{ type: 'Throw', value: optExpr(s.value) }];
    case 'Try': return [{
      type: 'Try', param: s.param,
      block: { type: 'Block', body: optSeq(s.block.body) },
      handler: s.handler ? { type: 'Block', body: optSeq(s.handler.body) } : null,
      finalizer: s.finalizer ? { type: 'Block', body: optSeq(s.finalizer.body) } : null,
    }];
    case 'Break': case 'Continue': return [s];
    case 'Seq': return [{ type: 'Seq', body: s.body.flatMap(optStmt) }];
    case 'Block': return [{ type: 'Block', body: optSeq(s.body) }];
    case 'If': {
      const test = optExpr(s.test);
      const cons = { type: 'Block', body: optSeq(s.cons.body) };
      const alt = s.alt
        ? (s.alt.type === 'If' ? optStmt(s.alt)[0] : { type: 'Block', body: optSeq(s.alt.body) })
        : null;
      if (isLit(test)) return truthy(litVal(test)) ? [cons] : (alt ? [alt] : []);
      return [{ type: 'If', test, cons, alt }];
    }
    case 'While': {
      const test = optExpr(s.test);
      if (isLit(test) && !truthy(litVal(test))) return []; // while(false){...} -> gone
      return [{ type: 'While', test, body: { type: 'Block', body: optSeq(s.body.body) } }];
    }
    case 'For': {
      const init = s.init ? optStmt(s.init)[0] : null;
      const test = s.test ? optExpr(s.test) : null;
      const update = s.update ? optStmt(s.update)[0] : null;
      return [{ type: 'For', init, test, update, body: { type: 'Block', body: optSeq(s.body.body) } }];
    }
    case 'FnDecl':
      return [{ type: 'FnDecl', name: s.name, params: s.params, body: { type: 'Block', body: optBody(s.body.body, s.params) }, async: s.async, generator: s.generator, protLevel: s.protLevel, prot: s.prot, restParam: s.restParam, _decoy: s._decoy }];
    default: return [s];
  }
}

// Optimize a statement sequence: map each statement, then drop everything after
// the first control-flow terminator (return / break / continue) -- unreachable.
function optSeq(stmts) {
  const out = [];
  for (const s of stmts) {
    for (const o of optStmt(s)) out.push(o);
    const last = out[out.length - 1];
    if (last && (last.type === 'Return' || last.type === 'Break' || last.type === 'Continue')) break;
  }
  return out;
}

// ---- constant propagation over a function body ----
// Across the whole (nested) body, count how many times each name is declared
// with `let` and whether it is ever assigned. A name declared exactly once,
// never assigned, not a parameter, whose initializer is a literal is a true
// constant: inline its reads and drop the binding.
function collectNames(stmts, decl, assigned) {
  const visitExpr = (e) => {
    if (!e || typeof e !== 'object') return;
    // An assignment can appear in expression position (e.g. `a = b = c`, or the
    // `(q = q + 1)` a postfix `q++` lowers to). Mark its target as assigned so it
    // is never mistaken for a write-once constant.
    if (e.type === 'Assign' && e.target && e.target.type === 'Ident') assigned[e.target.name] = true;
    // `typeof x` must stay a runtime read: a `var x` declared later is hoisted and
    // reads `undefined` there, so inlining its eventual value would be wrong.
    if (e.type === 'Unary' && e.op === 'typeof' && e.arg && e.arg.type === 'Ident') assigned[e.arg.name] = true;
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) v.forEach(visitExpr);
      else if (v && typeof v === 'object' && v.type) visitExpr(v);
    }
  };
  const visit = (s) => {
    switch (s.type) {
      case 'Let': decl[s.name] = (decl[s.name] || 0) + 1; visitExpr(s.value); break;
      case 'Assign':
        if (s.target.type === 'Ident') assigned[s.target.name] = true;
        visitExpr(s.target); visitExpr(s.value); break;
      case 'Block': s.body.forEach(visit); break;
      case 'If':
        visitExpr(s.test); s.cons.body.forEach(visit);
        if (s.alt) (s.alt.type === 'If' ? visit(s.alt) : s.alt.body.forEach(visit));
        break;
      case 'While': visitExpr(s.test); s.body.body.forEach(visit); break;
      case 'For':
        if (s.init) visit(s.init); if (s.test) visitExpr(s.test);
        if (s.update) visit(s.update); s.body.body.forEach(visit);
        break;
      case 'FnDecl': break; // nested fns are a separate scope (no closures)
      default: visitExpr(s);
    }
  };
  stmts.forEach(visit);
}

function substReads(node, consts) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'Ident' && Object.prototype.hasOwnProperty.call(consts, node.name)) {
    return { ...consts[node.name] };
  }
  if (node.type === 'FnDecl') return node; // do not cross into nested scope
  // Never rewrite an assignment target into a literal (it must stay an lvalue);
  // only substitute reads within the value and within Member/Index sub-expressions.
  if (node.type === 'Assign') {
    let target = node.target;
    if (target && target.type === 'Member') target = { ...target, object: substReads(target.object, consts) };
    else if (target && target.type === 'Index') target = { ...target, object: substReads(target.object, consts), index: substReads(target.index, consts) };
    return { ...node, target, value: substReads(node.value, consts) };
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) node[k] = v.map((x) => substReads(x, consts));
    else if (v && typeof v === 'object' && v.type) node[k] = substReads(v, consts);
  }
  return node;
}

// Collect every identifier name that appears inside a nested function (both
// expressions AND declarations) -- these may be captured as upvalues, so we must
// not inline or drop their bindings, or the upvalue's backing slot disappears.
function collectClosedOver(node, into) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FnExpr' || node.type === 'FnDecl') { collectIdents(node, into); return; }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => collectClosedOver(x, into));
    else if (v && typeof v === 'object') collectClosedOver(v, into);
  }
}
function collectIdents(node, into) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Ident') into.add(node.name);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => collectIdents(x, into));
    else if (v && typeof v === 'object') collectIdents(v, into);
  }
}

function optBody(stmts, params = []) {
  let body = optSeq(stmts);

  const decl = Object.create(null);
  const assigned = Object.create(null);
  collectNames(body, decl, assigned);
  const closedOver = new Set();
  body.forEach((s) => collectClosedOver(s, closedOver));
  const paramSet = new Set(params);
  const consts = Object.create(null);
  for (const s of body) {
    if (s.type === 'Let' && isLit(s.value) && decl[s.name] === 1 && !assigned[s.name]
        && !paramSet.has(s.name) && !closedOver.has(s.name)) {
      consts[s.name] = s.value;
    }
  }
  if (Object.keys(consts).length) {
    body = body
      .filter((s) => !(s.type === 'Let' && consts[s.name])) // drop the now-inlined bindings
      .map((s) => substReads(s, consts));
    body = optSeq(body); // inlining can expose new folds / dead branches
  }
  return body;
}

function optimize(ast) {
  // Split top-level into function declarations and main statements. The compiler
  // hoists FnDecls regardless of position, so re-emitting decls first is safe.
  const fns = [];
  const main = [];
  for (const s of ast.body) (s.type === 'FnDecl' ? fns : main).push(s);
  const optFns = fns.map((f) => optStmt(f)[0]);
  const optMain = optBody(main);
  return { type: 'Program', body: [...optFns, ...optMain] };
}

module.exports = { optimize };
