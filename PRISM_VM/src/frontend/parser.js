'use strict';
// Recursive-descent parser with precedence climbing for binary operators.
// Produces a plain-object AST consumed by compiler.js.

const { lex } = require('./lexer');

// Binary operator precedence (higher binds tighter).
const BINPREC = {
  '??': 1,
  '||': 1, '&&': 2,
  '|': 3, '^': 4, '&': 5,
  '===': 6, '!==': 6, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, 'instanceof': 7, 'in': 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
  '**': 11,
};

// Keyword tokens that act as binary operators (their token .type equals the
// operator text, not 'op').
const KEYWORD_BINOPS = new Set(['instanceof', 'in']);

// Directives that expand to code (as opposed to protection annotations).
const CODE_DIRECTIVES = new Set(['fn', 'function', 'call', 'dudret', 'if', 'exists', 'throw', 'quit', 'log', 'warn', 'decoy']);

// Temp-name counter is module-level so a recursive fragment parse (used to expand
// code directives) continues the outer numbering instead of colliding at __d0.
// A top-level parse resets it, keeping builds reproducible.
let TMP = 0;

function parse(src, parseOpts) {
  parseOpts = parseOpts || {};
  if (!parseOpts.fragment) TMP = 0;
  const toks = lex(src);
  let p = 0;

  const peek = () => toks[p];
  const next = () => toks[p++];
  const at = (type, value) => {
    const t = toks[p];
    return t.type === type && (value === undefined || t.value === value);
  };
  const eat = (type, value) => {
    const t = toks[p];
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new SyntaxError(`Expected ${value ?? type} but got '${t.value}' (${t.type}) at line ${t.line}`);
    }
    return next();
  };
  const eatOp = (v) => eat('op', v);
  const atOp = (v) => at('op', v);

  // End-of-statement: an explicit `;`, OR a context where a terminator is
  // implied — a closing brace, a following control keyword, end of input, or a
  // newline before the next token (ASI-lite). Semicolons are therefore optional.
  const endStatement = () => {
    if (atOp(';')) { eatOp(';'); return; }
    const t = toks[p];
    if (atOp('}') || at('else') || at('catch') || at('finally') || at('eof') || t.nl) return;
    eatOp(';'); // genuinely two statements on one line with no separator
  };

  // Accept an identifier OR any keyword-typed token as a plain name. Lets code
  // use words like `fn`, `get`, `of`, `value`, `class` in binding / property /
  // member positions (real JavaScript allows most of these there).
  const atName = () => {
    const t = toks[p];
    return t.type === 'ident' || (typeof t.value === 'string' && /^[A-Za-z_$]/.test(t.value) && t.type !== 'str' && t.type !== 'num');
  };
  const eatName = () => {
    const t = toks[p];
    if (!atName()) throw new SyntaxError(`Expected name but got '${t.value}' (${t.type}) at line ${t.line}`);
    return next().value;
  };
  // Current token's binary-operator text, or null. Handles both 'op' tokens and
  // keyword operators (instanceof / in).
  const curBinOp = () => {
    const t = toks[p];
    if (t.type === 'op' && BINPREC[t.value] !== undefined) return t.value;
    if (KEYWORD_BINOPS.has(t.type)) return t.type;
    return null;
  };

  // `fn` is both the `function` alias AND a legal identifier in .js input (many
  // files use a variable literally named `fn`). Treat the token at the cursor as
  // the function keyword only when it actually introduces a function.
  function fnIsFunctionExpr() {
    let j = p + 1;
    while (toks[j] && toks[j].type === 'directive') j++; // skip <@...> before the name
    const n1 = toks[j];
    if (!n1) return false;
    if (n1.type === 'op' && n1.value === '*') {                     // fn* generator ...
      // ... but only if a name or '(' follows the '*'. `fn * 2` is `fn` (an
      // identifier) multiplied, not a generator function.
      const n2 = toks[j + 1];
      if (!n2) return false;
      if (n2.type === 'op') return n2.value === '(';
      return n2.type !== 'str' && n2.type !== 'num' && typeof n2.value === 'string' && /^[A-Za-z_$]/.test(n2.value);
    }
    if (n1.type !== 'op' && n1.type !== 'str' && n1.type !== 'num'
        && typeof n1.value === 'string' && /^[A-Za-z_$]/.test(n1.value)) return true; // named
    if (n1.type === 'op' && n1.value === '(') {                     // anonymous: fn (..) {
      let depth = 0;
      for (let j = p + 1; j < toks.length; j++) {
        const t = toks[j];
        if (t.type === 'op' && t.value === '(') depth++;
        else if (t.type === 'op' && t.value === ')') { depth--; if (depth === 0) { const nx = toks[j + 1]; return nx && nx.type === 'op' && nx.value === '{'; } }
        else if (t.type === 'eof') return false;
      }
    }
    return false;
  }

  // Declaration-level rename requests from <@name ...> directives, applied
  // program-wide after parsing so every reference to a renamed binding updates.
  const renameReqs = [];

  // Rename variable identifiers `from`->`to` throughout a subtree. Skips object
  // property names, member accesses and literal keys (those are not variables).
  function renameIdent(node, map) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) renameIdent(n, map); return; }
    if (node.type === 'Ident' && map[node.name]) node.name = map[node.name];
    if ((node.type === 'Let' || node.type === 'FnDecl' || node.type === 'Class' || node.type === 'FnExpr') && node.name && map[node.name]) node.name = map[node.name];
    if (node.type === 'Try' && node.param && map[node.param]) node.param = map[node.param];
    if (Array.isArray(node.params)) node.params = node.params.map((pn) => map[pn] || pn);
    for (const k of Object.keys(node)) {
      if (k === 'property' || k === 'key' || k === 'name' || k === 'params' || k === 'param' || k === 'type' || k === 'directives' || k === 'prot') continue;
      const v = node[k];
      if (v && typeof v === 'object') renameIdent(v, map);
    }
  }

  function parseProgram() {
    const body = [];
    while (!at('eof')) body.push(parseStatement());
    const prog = { type: 'Program', body };
    if (renameReqs.length) { const map = {}; for (const r of renameReqs) map[r.from] = r.to; renameIdent(prog, map); }
    return prog;
  }

  function parseBlock() {
    eatOp('{');
    const body = [];
    while (!atOp('}')) body.push(parseStatement());
    eatOp('}');
    return { type: 'Block', body };
  }

  // Map protection annotations to a per-function protection level:
  //   @native -> 0 (no bytecode encryption), @weak -> 1, @medium/@virtualize -> 2,
  //   @heavy -> 3. @virtualize <strength> uses the named strength.
  function protLevelFromAnnots(annots) {
    let level = 1; // default (weak)
    for (const a of annots) {
      const parts = a.split(/\s+/).filter(Boolean);
      const head = parts[0];
      if (head === 'native') level = 0;
      else if (head === 'weak') level = 1;
      else if (head === 'medium') level = 2;
      else if (head === 'heavy') level = 3;
      else if (head === 'virtualize') {
        const s = parts[1];
        level = s === 'weak' ? 1 : s === 'heavy' ? 3 : 2;
      }
    }
    return level;
  }

  function attachAnnots(stmt, annots) {
    if (!annots.length) return stmt;
    const level = protLevelFromAnnots(annots);
    if (stmt.type === 'FnDecl') stmt.protLevel = level;
    else if (stmt.type === 'Let' && stmt.value && stmt.value.type === 'FnExpr') stmt.value.protLevel = level;
    return stmt;
  }

  // ---- inline compiler directives (<@...>) ----
  const LEVELS = { min: 1, med: 2, max: 3, low: 1, medium: 2, high: 3, weak: 1, heavy: 3 };
  const collectDirectives = () => {
    const ds = [];
    while (at('directive')) ds.push(next().value);
    return ds;
  };
  // Fold a directive list into a protection descriptor (levels + per-pass knobs).
  function directivesToProt(ds) {
    const prot = {};
    for (const d of ds) {
      const lvl = (d.args[0] && LEVELS[d.args[0].toLowerCase()]) || undefined;
      switch (d.name) {
        case 'native': prot.level = 0; prot.native = true; break;
        case 'virtualization': case 'virtualize': prot.level = lvl != null ? lvl : (prot.level || 2); break;
        case 'weak': prot.level = 1; break;
        case 'medium': prot.level = 2; break;
        case 'heavy': prot.level = 3; break;
        case 'deadcode': prot.deadcode = lvl != null ? lvl : 2; break;
        case 'controlflow': prot.controlFlow = lvl != null ? lvl : 2; break;
        case 'flat': prot.flatten = true; if (prot.level == null) prot.level = 2; break;   // control-flow flattening
        case 'bogus': prot.bogus = lvl != null ? lvl : 2; if (prot.level == null) prot.level = 2; break; // opaque predicates / dead states
        case 'split': prot.split = true; if (prot.level == null) prot.level = 2; break;    // basic-block splitting
        case 'sourcemap': prot.sourcemap = (d.args[0] || 'on').toLowerCase() !== 'off'; break;
        case 'name': prot.rename = d.args[0] || '*random*'; break;
        default: break;
      }
    }
    return prot;
  }
  // Apply a protection descriptor to a declaration statement / function value.
  function attachDirectives(stmt, ds) {
    if (!ds.length) return stmt;
    const prot = directivesToProt(ds);
    const fnNode = stmt.type === 'FnDecl' ? stmt
      : (stmt.type === 'Let' && stmt.value && stmt.value.type === 'FnExpr') ? stmt.value
        : (stmt.type === 'Class') ? stmt : null;
    if (fnNode && prot.level != null) fnNode.protLevel = prot.level;
    if (fnNode) fnNode.prot = Object.assign({}, fnNode.prot, prot);
    if (prot.rename) {
      // Register a program-wide rename of the declared binding so every reference
      // is updated too (applied after the whole program is parsed).
      const to = prot.rename === '*random*' ? randomName() : prot.rename;
      if (stmt.type === 'FnDecl' && stmt.name) renameReqs.push({ from: stmt.name, to });
      else if (stmt.type === 'Let' && stmt.name) renameReqs.push({ from: stmt.name, to });
    }
    stmt.directives = ds;
    return stmt;
  }
  // <@encstr "value" mode> -> an expression that rebuilds the string at runtime.
  // The literal never appears verbatim in the constant pool.
  function encStrNode(value, mode) {
    const str = String(value);
    if (mode === 'random') mode = ['str_arr', 'bytecode', 'hex'][(Math.random() * 3) | 0];
    if (mode === 'str_arr') {
      const elements = Array.from(str).map((ch) => ({ type: 'Str', value: ch }));
      return { type: 'Call', callee: { type: 'Member', object: { type: 'Array', elements }, property: 'join' }, args: [{ type: 'Str', value: '' }] };
    }
    // bytecode / hex: reconstruct from character codes via String.fromCharCode.
    const codes = Array.from(str).map((ch) => ({ type: 'Num', value: ch.charCodeAt(0) }));
    return { type: 'Call', callee: { type: 'Member', object: { type: 'Ident', name: 'String' }, property: 'fromCharCode' }, args: codes };
  }

  // <@encstr ...>NUMBER -> reconstruct an integer literal at runtime as (A ^ B)
  // so the plaintext value never appears in the constant pool. Falls back to the
  // literal for non-u32 values (XOR only reconstructs unsigned 32-bit integers).
  function encNumNode(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff || Object.is(value, -0)) return { type: 'Num', value };
    const A = (Math.random() * 0x100000000) >>> 0;
    const B = (value ^ A) >>> 0;
    return { type: 'Binary', op: '^', left: { type: 'Num', value: A }, right: { type: 'Num', value: B } };
  }

  // <@random max min> -> a runtime expression yielding a random integer in
  // [min, max] (inclusive). Args are optional; defaults to [0, 1].
  function randomNode(a, b) {
    let max = a !== undefined ? Number(a) : 1;
    let min = b !== undefined ? Number(b) : 0;
    if (!isFinite(max)) max = 1; if (!isFinite(min)) min = 0;
    if (min > max) { const t = min; min = max; max = t; }
    const range = max - min + 1;
    return {
      type: 'Binary', op: '+',
      left: { type: 'Call', callee: { type: 'Ident', name: 'floor' }, args: [
        { type: 'Binary', op: '*', left: { type: 'Call', callee: { type: 'Ident', name: 'rand' }, args: [] }, right: { type: 'Num', value: range } }] },
      right: { type: 'Num', value: min },
    };
  }

  let renameCounter = 0;
  function randomName() {
    const alpha = 'IlamlIxkANmzZqQoO0';
    let s = '_';
    for (let k = 0; k < 10; k++) s += alpha[(Math.random() * alpha.length) | 0];
    return s + (renameCounter++);
  }

  function parseStatement() {
    // A standalone code directive (<@fn>, <@call>, <@throw>, <@quit>, <@log>, ...)
    // IS the statement -- expand it directly rather than attaching to a follower.
    if (at('directive') && CODE_DIRECTIVES.has(peek().value.name)) {
      const d = next().value;
      const node = expandDirectiveStmt(d);
      if (atOp(';')) eatOp(';');
      if (node) return node;
    }
    if (at('annot') || at('directive')) {
      const annots = [];
      const directives = [];
      while (at('annot') || at('directive')) { if (at('annot')) annots.push(next().value); else directives.push(next().value); }
      let stmt = parseStatement();
      stmt = attachAnnots(stmt, annots);
      stmt = attachDirectives(stmt, directives);
      return stmt;
    }
    const t = peek();
    if (t.type === 'let') return parseLet();
    if (t.type === 'fn' && fnIsFunctionExpr()) return parseFn();
    // 'async function' as a top-level declaration
    if (t.type === 'async' && toks[p+1] && toks[p+1].type === 'fn') return parseFn();
    if (t.type === 'class') return parseClass(false);
    if (t.type === 'import') return parseImport();
    if (t.type === 'export') { // `export [default] <decl>` -> just the declaration
      eat('export'); if (at('ident', 'default')) next();
      if (atOp('{')) { // export { a, b } [from '...']; -> no-op binding list
        eatOp('{'); while (!atOp('}')) { eatName(); if (at('ident', 'as')) { next(); eatName(); } if (atOp(',')) eatOp(','); else break; } eatOp('}');
        if (at('ident', 'from')) { next(); if (at('str')) next(); }
        if (atOp(';')) eatOp(';');
        return { type: 'Seq', body: [] };
      }
      return parseStatement();
    }
    if (t.type === 'return') return parseReturn();
    if (t.type === 'if') return parseIf();
    if (t.type === 'while') return parseWhile();
    if (t.type === 'for') return parseFor();
    // `switch` is a contextual keyword (ordinary identifier in the lexer): only a
    // `switch (` opener starts a switch statement, so `switch` stays usable as a name.
    if (t.type === 'ident' && t.value === 'switch' && toks[p + 1] && toks[p + 1].type === 'op' && toks[p + 1].value === '(') return parseSwitch();
    if (t.type === 'break') { eat('break'); if (atOp(';')) eatOp(';'); return { type: 'Break' }; }
    if (t.type === 'continue') { eat('continue'); if (atOp(';')) eatOp(';'); return { type: 'Continue' }; }
    if (t.type === 'try') return parseTry();
    if (t.type === 'throw') { eat('throw'); const value = parseExpr(); if (atOp(';')) eatOp(';'); return { type: 'Throw', value }; }
    if (t.type === 'print') return parsePrint();
    if (atOp('{')) return parseBlock();

    const node = parseSimple();
    endStatement();
    return node;
  }

  // Compound-assignment operators lower to `target = target <op> rhs`.
  const ASSIGN_OPS = {
    '=': null, '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%',
    '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>', '>>>=': '>>>',
  };

  // Parse one "simple statement" (assignment, compound assignment,
  // increment/decrement, or a bare expression) WITHOUT consuming a terminator.
  // Shared by statements and by the init/update clauses of `for`.
  function parseSimple() {
    // prefix ++/--
    if (atOp('++') || atOp('--')) {
      const op = next().value === '++' ? '+' : '-';
      const target = parseExpr();
      return incDec(target, op);
    }
    const expr = parseExpr();
    const t = peek();
    if (t.type === 'op' && Object.prototype.hasOwnProperty.call(ASSIGN_OPS, t.value)) {
      const aop = next().value;
      const rhs = parseExpr();
      const value = aop === '='
        ? rhs
        : { type: 'Binary', op: ASSIGN_OPS[aop], left: expr, right: rhs };
      return { type: 'Assign', target: expr, value };
    }
    // postfix ++/--
    if (atOp('++') || atOp('--')) {
      const op = next().value === '++' ? '+' : '-';
      return incDec(expr, op);
    }
    return { type: 'ExprStmt', expr };
  }

  function incDec(target, op) {
    return {
      type: 'Assign',
      target,
      value: { type: 'Binary', op, left: target, right: { type: 'Num', value: 1 } },
    };
  }

  // ---- destructuring & parameters ----
  const freshTmp = () => `__d${TMP++}`;

  // Expand a code directive into an AST node by synthesizing equivalent source
  // and re-parsing it as a fragment (nested directives inside are handled too).
  const fragStmts = (s) => parse(s, { fragment: true }).body;
  const fragExpr = (s) => {
    const prog = parse('let __vmgen_frag = (' + s + ');', { fragment: true });
    const ln = prog.body.find((n) => n.type === 'Let' && n.name === '__vmgen_frag');
    return ln ? ln.value : { type: 'Null' };
  };
  // Split a directive body into comma-separated call args, preserving quoted
  // strings (each whitespace/quote-delimited part becomes one argument).
  // Split a directive body into arguments, treating a quoted string or a nested
  // `<@...>` directive (with its own nesting) as a single argument, and splitting
  // the rest on whitespace. Keeps quotes so string literals survive.
  const rawParts = (rest) => {
    const out = []; let i = 0; const N = rest.length;
    while (i < N) {
      while (i < N && /\s/.test(rest[i])) i++;
      if (i >= N) break;
      let part = '';
      const c = rest[i];
      if (c === '"' || c === "'" || c === '`') { const qq = c; part += rest[i++]; while (i < N && rest[i] !== qq) part += rest[i++]; if (i < N) part += rest[i++]; }
      else if (c === '<' && rest[i + 1] === '@') { let d = 0; while (i < N) { if (rest[i] === '<' && rest[i + 1] === '@') { part += '<@'; i += 2; d++; continue; } if (rest[i] === '>') { part += '>'; i++; d--; if (d === 0) break; continue; } part += rest[i++]; } }
      else { while (i < N && !/\s/.test(rest[i])) part += rest[i++]; }
      out.push(part);
    }
    return out;
  };
  const logArgs = (rest) => rawParts(rest).join(', ');
  // <@if a b> / <@exists v> read positional args from the raw body so quoted
  // strings survive (the token's `args` are quote-stripped, which would turn
  // "big" into the identifier big).
  const ifExpr = (rest) => { const P = rawParts(rest); return '((' + (P[0] || 'null') + ') ? (' + (P.slice(1).join(' ') || 'null') + ') : null)'; };
  const existsExpr = (rest) => '(typeof ' + (rawParts(rest)[0] || 'undefined') + ' !== "undefined")';
  // Statement-position expansion. Returns an AST statement, or null if `d` is not
  // a code directive.
  function expandDirectiveStmt(d) {
    const stmt = (expr) => ({ type: 'ExprStmt', expr }); // an expression used as a statement
    switch (d.name) {
      case 'fn': case 'function': return fragStmts('function ' + d.rest)[0];        // <@fn name(args){body}>
      case 'call': return stmt(fragExpr(d.rest));                                    // <@call f(args)>
      case 'log': return stmt(fragExpr('console.log(' + logArgs(d.rest) + ')'));      // <@log ...msg>
      case 'warn': return stmt(fragExpr('console.warn(' + logArgs(d.rest) + ')'));    // <@warn ...msg>
      case 'throw': return fragStmts('throw (' + d.rest + ');')[0];                  // <@throw err>
      case 'quit': return { type: 'Return', value: { type: 'Null' } };              // <@quit>
      case 'dudret': return fragStmts('if (rand() < 0) { return (' + d.rest + '); }')[0]; // <@dudret v> dead return
      case 'decoy': {                                                                // <@decoy x> (x = 0..3 strength)
        const x = Math.max(0, Math.min(3, parseInt(d.args[0] || '1', 10) || 0));
        const nm = randomName();
        const k = 3 + x * 4, n = 100 + x * 371, m = 7 + x * 3;
        // A plausible but never-referenced function (dead code = decoy). Strength
        // scales its size and its cipher rounds (protLevel).
        let inner = '';
        for (let j = 0; j <= x; j++) inner += `    if (acc > ${n + j * 13}) { acc = (acc - ${m + j}) >>> 0; } else { acc = (acc * 33 + ${k + j}) >>> 0; }\n`;
        const body = `function ${nm}(a, b) {\n  let acc = ((a | 0) ^ ${n}) >>> 0;\n  for (let i = 0; i < ${k}; i = i + 1) { acc = ((acc * 31 + (b | 0)) ^ (i << 2)) >>> 0;\n${inner}  }\n  return acc >>> 0;\n}`;
        const fn = fragStmts(body)[0];
        if (fn) { fn.protLevel = x; fn._decoy = true; }
        return fn;
      }
      case 'if': return stmt(fragExpr(ifExpr(d.rest)));
      case 'exists': return stmt(fragExpr(existsExpr(d.rest)));
      default: return null;
    }
  }
  // Expression-position expansion (only the value-producing directives).
  function expandDirectiveExpr(d) {
    switch (d.name) {
      case 'call': return fragExpr(d.rest);
      case 'log': return fragExpr('console.log(' + logArgs(d.rest) + ')');
      case 'warn': return fragExpr('console.warn(' + logArgs(d.rest) + ')');
      case 'if': return fragExpr(ifExpr(d.rest));
      case 'exists': return fragExpr(existsExpr(d.rest));
      case 'dudret': return fragExpr(d.rest); // as a value, just the (dud) value
      default: return null;
    }
  }

  // Parse a `{...}` / `[...]` binding pattern. Returns a Pattern descriptor that
  // `destructure()` desugars into plain Let/Assign statements against a source.
  function parsePattern() {
    if (atOp('{')) {
      eatOp('{');
      const props = []; let rest = null;
      while (!atOp('}')) {
        if (atOp('...')) { eatOp('...'); rest = eatName(); break; }
        let computed = false, key;
        if (atOp('[')) { computed = true; eatOp('['); key = parseExpr(); eatOp(']'); }
        else key = eatName();
        let target;
        if (atOp(':')) { eatOp(':'); target = parseBindingTarget(); }
        else target = key; // shorthand { a } -> a = src.a
        let def = null;
        if (atOp('=')) { eatOp('='); def = parseExpr(); }
        props.push({ key, computed, target, def });
        if (atOp(',')) eatOp(','); else break;
      }
      eatOp('}');
      return { kind: 'obj', props, rest };
    }
    eatOp('[');
    const elements = []; let rest = null;
    while (!atOp(']')) {
      if (atOp(',')) { elements.push(null); eatOp(','); continue; } // elision / hole
      if (atOp('...')) { eatOp('...'); rest = parseBindingTarget(); break; }
      const target = parseBindingTarget();
      let def = null;
      if (atOp('=')) { eatOp('='); def = parseExpr(); }
      elements.push({ target, def });
      if (atOp(',')) eatOp(','); else break;
    }
    eatOp(']');
    return { kind: 'arr', elements, rest };
  }

  function parseBindingTarget() {
    if (atOp('{') || atOp('[')) return parsePattern();
    return eatName();
  }

  // `undefined ? default : access`  (VM treats a missing property as null).
  function withDefault(access, def) {
    return {
      type: 'Ternary',
      test: { type: 'Binary', op: '===', left: access, right: { type: 'Ident', name: 'undefined' } },
      cons: def, alt: access,
    };
  }

  // Desugar `pattern = srcExpr` into a list of Let statements appended to `out`.
  function destructure(pattern, srcExpr, out) {
    if (pattern.kind === 'obj') {
      for (const pr of pattern.props) {
        const access = pr.computed
          ? { type: 'Index', object: srcExpr, index: pr.key }
          : { type: 'Member', object: srcExpr, property: pr.key };
        bindTarget(pr.target, pr.def ? withDefault(access, pr.def) : access, out);
      }
      if (pattern.rest) out.push({ type: 'Let', name: pattern.rest, value: srcExpr }); // best-effort
    } else {
      let i = 0;
      for (const el of pattern.elements) {
        const idx = i++;
        if (!el) continue; // hole
        const access = { type: 'Index', object: srcExpr, index: { type: 'Num', value: idx } };
        bindTarget(el.target, el.def ? withDefault(access, el.def) : access, out);
      }
      if (pattern.rest) bindTarget(pattern.rest, srcExpr, out); // best-effort
    }
  }

  function bindTarget(target, valExpr, out) {
    if (typeof target === 'string') { out.push({ type: 'Let', name: target, value: valExpr }); return; }
    const t = freshTmp();
    out.push({ type: 'Let', name: t, value: valExpr });
    destructure(target, { type: 'Ident', name: t }, out);
  }

  // Parse a parameter list. Destructuring / default / rest params are normalised
  // into a plain name list plus a `prologue` of statements prepended to the body.
  function parseParamList() {
    eatOp('(');
    const names = []; const prologue = []; const renames = {}; let k = 0; let restIndex = null;
    while (!atOp(')')) {
      // <@name x> / <@name> before a parameter renames it (random when default).
      let paramRename = null;
      if (at('directive')) {
        const prot = directivesToProt(collectDirectives());
        if (prot.rename) paramRename = prot.rename === '*random*' ? randomName() : prot.rename;
      }
      if (atOp('...')) { eatOp('...'); const rn = eatName(); const nm = paramRename || rn; restIndex = names.length; names.push(nm); if (paramRename) renames[rn] = nm; break; }
      if (atOp('{') || atOp('[')) {
        const pattern = parsePattern();
        const syn = `__arg${k++}`; names.push(syn);
        if (atOp('=')) { eatOp('='); parseExpr(); } // default on a destructured param: ignored
        destructure(pattern, { type: 'Ident', name: syn }, prologue);
      } else {
        const orig = eatName();
        const n = paramRename || orig; names.push(n);
        // rename is applied scoped to the function body by the caller.
        if (paramRename && paramRename !== orig) renames[orig] = n;
        if (atOp('=')) {
          eatOp('='); const def = parseExpr();
          prologue.push({ type: 'Assign', target: { type: 'Ident', name: n }, value: withDefault({ type: 'Ident', name: n }, def) });
        }
      }
      if (atOp(',')) eatOp(','); else break;
    }
    eatOp(')');
    return { names, prologue, renames, restIndex };
  }

  // Assemble a function body: prepend the param prologue and apply any scoped
  // parameter renames (so references to the original param name update).
  function withPrologue(prologue, block, renames) {
    const b = prologue && prologue.length ? { type: 'Block', body: [...prologue, ...block.body] } : block;
    if (renames && Object.keys(renames).length) renameIdent(b, renames);
    return b;
  }

  // ---- classes ----
  // Desugared to an Object value carrying the constructor, method table and a
  // link to the superclass; `new` and method dispatch consult that at runtime.
  function parseClassBody() {
    eatOp('{');
    const members = [];
    while (!atOp('}')) {
      if (atOp(';')) { eatOp(';'); continue; }
      let isStatic = false, isAsync = false, isGen = false, kind = 'method';
      if (at('ident', 'static') && !nextIsMemberEnd()) { next(); isStatic = true; }
      if (at('async') && !nextIsMemberEnd()) { next(); isAsync = true; }
      if (atOp('*')) { eatOp('*'); isGen = true; }
      if ((at('ident', 'get') || at('ident', 'set')) && !nextIsMemberEnd()) { kind = next().value; }
      let computed = false, key;
      if (atOp('[')) { computed = true; eatOp('['); key = parseExpr(); eatOp(']'); }
      else key = eatName();
      const { names, prologue, renames, restIndex } = parseParamList();
      const block = parseBlock();
      members.push({ kind, static: isStatic, computed, key, value: { type: 'FnExpr', name: null, params: names, body: withPrologue(prologue, block, renames), async: isAsync, generator: isGen, restParam: restIndex } });
    }
    eatOp('}');
    return members;
  }
  // A method modifier word (static/async/get/set) is a real member name when the
  // next token is '(' or '=' or the member terminator.
  function nextIsMemberEnd() {
    const n = toks[p + 1];
    return n && n.type === 'op' && (n.value === '(' || n.value === '=' || n.value === ';' || n.value === '}');
  }

  function parseClass(asExpr) {
    eat('class');
    let name = null;
    if (atName() && !at('extends') && !atOp('{')) name = eatName();
    let superClass = null;
    if (at('extends')) { eat('extends'); superClass = parseUnary(); }
    const members = parseClassBody();
    return { type: 'Class', name, superClass, members, expr: !!asExpr };
  }

  // ---- modules ----
  function parseImport() {
    eat('import');
    // Bare side-effect import `import "mod";` is the province of the compile-time
    // .vgs module expander (src/modules.js); if one reaches the parser it was not
    // expanded (no resolver), so reject it rather than silently dropping code.
    if (at('str')) { const src = peek().value; throw new SyntaxError(`import "${src}" requires a module resolver`); }
    const out = [];
    let defaultName = null; const named = [];
    if (atName()) defaultName = eatName();
    if (atOp(',')) eatOp(',');
    if (atOp('*')) { eatOp('*'); if (at('ident', 'as')) next(); const ns = eatName(); named.push({ imported: null, local: ns, ns: true }); }
    else if (atOp('{')) {
      eatOp('{');
      while (!atOp('}')) {
        const imported = eatName(); let local = imported;
        if (at('ident', 'as')) { next(); local = eatName(); }
        named.push({ imported, local });
        if (atOp(',')) eatOp(','); else break;
      }
      eatOp('}');
    }
    if (at('ident', 'from')) next();
    const src = at('str') ? next().value : '';
    if (atOp(';')) eatOp(';');
    const tmp = freshTmp();
    out.push({ type: 'Let', name: tmp, value: requireCall(src) });
    if (defaultName) out.push({ type: 'Let', name: defaultName, value: { type: 'Ident', name: tmp } });
    for (const n of named) {
      out.push({ type: 'Let', name: n.local, value: n.ns ? { type: 'Ident', name: tmp } : { type: 'Member', object: { type: 'Ident', name: tmp }, property: n.imported } });
    }
    return { type: 'Seq', body: out };
  }
  function requireCall(src) {
    return { type: 'Call', callee: { type: 'Ident', name: 'require' }, args: [{ type: 'Str', value: src }] };
  }

  function parseTry() {
    eat('try');
    const block = parseBlock();
    let param = null;
    let handler = null;
    let finalizer = null;
    if (at('catch')) {
      eat('catch');
      if (atOp('(')) {
        eatOp('(');
        if (atOp('{') || atOp('[')) {
          // destructured catch binding: bind to a temp, destructure in-handler
          const pattern = parsePattern(); const tmp = freshTmp(); param = tmp; eatOp(')');
          const block = parseBlock();
          const pro = []; destructure(pattern, { type: 'Ident', name: tmp }, pro);
          handler = { type: 'Block', body: [...pro, ...block.body] };
        } else { param = eatName(); eatOp(')'); handler = parseBlock(); }
      } else { handler = parseBlock(); }
    }
    if (at('finally')) { eat('finally'); finalizer = parseBlock(); }
    if (!handler && !finalizer) throw new SyntaxError('try must have a catch or finally');
    return { type: 'Try', block, param, handler, finalizer };
  }

  function parseFor() {
    eat('for');
    if (at('await')) next(); // for await (...) -> treat as for-of
    eatOp('(');
    // for-of / for-in: `for ([let|const] <target> of|in <expr>) body`
    const save = p;
    let isDecl = false;
    if (at('let')) { isDecl = true; }
    // lookahead for `of`/`in` after the loop variable/pattern
    if (looksLikeForInOf()) {
      if (isDecl) eat('let');
      const target = (atOp('{') || atOp('[')) ? parsePattern() : eatName();
      const kind = at('ident', 'of') ? 'of' : (at('in') ? 'in' : null);
      next(); // consume of/in
      const iter = parseExpr();
      eatOp(')');
      const body = parseBody();
      // Desugar to an index loop over a snapshot of the iterable. `len`/index
      // access cover arrays and strings; `for-in` yields keys via `keys()`.
      const s = freshTmp(), i = freshTmp();
      const source = kind === 'in'
        ? { type: 'Call', callee: { type: 'Ident', name: 'keys' }, args: [iter] }
        : iter;
      const elem = { type: 'Index', object: { type: 'Ident', name: s }, index: { type: 'Ident', name: i } };
      const bindings = [];
      if (typeof target === 'string') bindings.push({ type: 'Let', name: target, value: elem });
      else destructure(target, elem, bindings);
      const forNode = {
        type: 'For',
        init: { type: 'Let', name: i, value: { type: 'Num', value: 0 } },
        test: { type: 'Binary', op: '<', left: { type: 'Ident', name: i }, right: { type: 'Call', callee: { type: 'Ident', name: 'len' }, args: [{ type: 'Ident', name: s }] } },
        update: { type: 'Assign', target: { type: 'Ident', name: i }, value: { type: 'Binary', op: '+', left: { type: 'Ident', name: i }, right: { type: 'Num', value: 1 } } },
        body: { type: 'Block', body: [...bindings, ...body.body] },
      };
      return { type: 'Block', body: [{ type: 'Let', name: s, value: source }, forNode] };
    }
    p = save;
    let init = null;
    if (atOp(';')) { eatOp(';'); }
    else if (at('let')) { init = parseLet(); } // parseLet consumes its own ';'
    else { init = parseSimple(); eatOp(';'); }
    let test = null;
    if (!atOp(';')) test = parseExpr();
    eatOp(';');
    let update = null;
    if (!atOp(')')) update = parseSimple();
    eatOp(')');
    const body = parseBody();
    return { type: 'For', init, test, update, body };
  }

  // Scan the head of a for(...) to decide if it is a for-of / for-in.
  function looksLikeForInOf() {
    let j = p; if (toks[j] && toks[j].type === 'let') j++;
    let depth = 0;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.type === 'op' && (t.value === '(' || t.value === '[' || t.value === '{')) depth++;
      else if (t.type === 'op' && (t.value === ')' || t.value === ']' || t.value === '}')) { if (depth === 0) return false; depth--; }
      else if (depth === 0 && t.type === 'op' && t.value === ';') return false;
      else if (depth === 0 && ((t.type === 'ident' && t.value === 'of') || t.type === 'in')) return true;
      else if (t.type === 'eof') return false;
    }
    return false;
  }

  function parseLet() {
    eat('let');
    // directive placed directly before the binding name, e.g.
    //   const <@name test>secret = "..."   /   let <@encstr ...> is not valid here
    let bindRename = null;
    if (at('directive')) {
      const prot = directivesToProt(collectDirectives());
      if (prot.rename) bindRename = prot.rename === '*random*' ? randomName() : prot.rename;
    }
    // destructuring declaration: let {a,b} = e; / let [a,,c] = e;
    if (atOp('{') || atOp('[')) {
      const pattern = parsePattern();
      eatOp('=');
      const value = parseExpr();
      if (atOp(';')) eatOp(';');
      const out = []; const t = freshTmp();
      out.push({ type: 'Let', name: t, value });
      destructure(pattern, { type: 'Ident', name: t }, out);
      return { type: 'Seq', body: out };
    }
    const name = eatName();
    if (bindRename) renameReqs.push({ from: name, to: bindRename });
    // Initializer is optional: `let x;` declares an uninitialized (null) binding.
    let value = null;
    if (atOp('=')) { eatOp('='); value = parseExpr(); }
    // multiple declarators: let a = 1, b = 2;
    if (atOp(',')) {
      const out = [{ type: 'Let', name, value }];
      while (atOp(',')) {
        eatOp(',');
        const n2 = eatName(); let v2 = null;
        if (atOp('=')) { eatOp('='); v2 = parseExpr(); }
        out.push({ type: 'Let', name: n2, value: v2 });
      }
      if (atOp(';')) eatOp(';');
      return { type: 'Seq', body: out };
    }
    if (atOp(';')) eatOp(';');
    return { type: 'Let', name, value };
  }

  function parseFn() {
    let isAsync = false;
    if (at('async')) { next(); isAsync = true; }
    eat('fn');
    let isGen = false; if (atOp('*')) { eatOp('*'); isGen = true; }
    // directive directly before the name: function <@name calc>add(...) {}
    let declRename = null;
    if (at('directive')) { const prot = directivesToProt(collectDirectives()); if (prot.rename) declRename = prot.rename === '*random*' ? randomName() : prot.rename; }
    const name = eatName();
    if (declRename) renameReqs.push({ from: name, to: declRename });
    const { names, prologue, renames, restIndex } = parseParamList();
    const block = parseBlock();
    return { type: 'FnDecl', name, params: names, body: withPrologue(prologue, block, renames), async: isAsync, generator: isGen, restParam: restIndex };
  }

  // Anonymous / named function expression: fn [name] (params) { body }.
  function parseFnExpr() {
    let isAsync = false;
    if (at('async')) { next(); isAsync = true; }
    eat('fn');
    let isGen = false; if (atOp('*')) { eatOp('*'); isGen = true; }
    let declRename = null;
    if (at('directive')) { const prot = directivesToProt(collectDirectives()); if (prot.rename) declRename = prot.rename === '*random*' ? randomName() : prot.rename; }
    let name = null;
    if (atName()) name = eatName(); // optional name (self-reference)
    if (declRename && name) renameReqs.push({ from: name, to: declRename });
    const { names, prologue, renames, restIndex } = parseParamList();
    const block = parseBlock();
    return { type: 'FnExpr', name, params: names, body: withPrologue(prologue, block, renames), async: isAsync, generator: isGen, restParam: restIndex };
  }

  function parseReturn() {
    eat('return');
    let value = null;
    // Automatic semicolon insertion: `return` is a restricted production -- a
    // newline right after it terminates the statement (bare return), so
    //   if (x) return
    //   this.y = 1
    // does NOT parse as `return this.y`.
    if (!toks[p].nl && !atOp(';') && !atOp('}') && !at('else') && !at('catch') && !at('finally') && !at('eof')) value = parseExpr();
    if (atOp(';')) eatOp(';');
    return { type: 'Return', value };
  }

  // Parse a loop / clause body: either a `{ ... }` block or a single statement
  // (wrapped in a Block so downstream passes always see one). Mirrors parseIf.
  function parseBody() {
    return atOp('{') ? parseBlock() : { type: 'Block', body: [parseStatement()] };
  }

  function parseIf() {
    eat('if');
    eatOp('(');
    const test = parseExpr();
    eatOp(')');
    // allow either a block or a single statement (e.g. `if (x) return y`);
    // single statements are wrapped so downstream passes always see a Block.
    const cons = atOp('{') ? parseBlock() : { type: 'Block', body: [parseStatement()] };
    let alt = null;
    if (at('else')) {
      eat('else');
      alt = at('if') ? parseIf() : (atOp('{') ? parseBlock() : { type: 'Block', body: [parseStatement()] });
    }
    return { type: 'If', test, cons, alt };
  }

  function parseWhile() {
    eat('while');
    eatOp('(');
    const test = parseExpr();
    eatOp(')');
    const body = parseBody();
    return { type: 'While', test, body };
  }

  // switch(disc){ case A: ... default: ... } -- desugared to a discriminant temp,
  // an entry-index computation (first matching case, else default, else past-end),
  // and a one-shot loop whose bodies run from the entry index onward (so C-style
  // fall-through works) and whose `break` exits the switch. `switch`/`case`/
  // `default` are ordinary identifiers in the lexer, matched contextually here.
  function parseSwitch() {
    next(); // 'switch'
    eatOp('(');
    const disc = parseExpr();
    eatOp(')');
    eatOp('{');
    const clauses = []; // { test: expr | null(default), body: [stmt] }
    while (!atOp('}') && !at('eof')) {
      if (at('ident', 'case')) { next(); const test = parseExpr(); eatOp(':'); clauses.push({ test, body: [] }); }
      else if (at('ident', 'default')) { next(); eatOp(':'); clauses.push({ test: null, body: [] }); }
      else {
        if (clauses.length === 0) throw new SyntaxError(`Unexpected statement before first case at line ${toks[p].line}`);
        clauses[clauses.length - 1].body.push(parseStatement());
      }
    }
    eatOp('}');
    return desugarSwitch(disc, clauses);
  }

  function desugarSwitch(disc, clauses) {
    const d = freshTmp(), k = freshTmp(), once = freshTmp();
    const LEN = clauses.length;
    let defaultIdx = -1;
    clauses.forEach((c, j) => { if (c.test === null) defaultIdx = j; });
    const idn = (n) => ({ type: 'Ident', name: n });
    const num = (v) => ({ type: 'Num', value: v });
    const bin = (op, left, right) => ({ type: 'Binary', op, left, right });
    const assign = (n, v) => ({ type: 'Assign', target: idn(n), value: v });
    const out = [];
    out.push({ type: 'Let', name: d, value: disc });
    out.push({ type: 'Let', name: k, value: num(-1) });
    // entry-index tests: first case whose value strictly-equals the discriminant
    clauses.forEach((c, j) => {
      if (c.test === null) return;
      out.push({ type: 'If', test: bin('&&', bin('<', idn(k), num(0)), bin('===', idn(d), c.test)),
        cons: { type: 'Block', body: [assign(k, num(j))] }, alt: null });
    });
    // no case matched -> default (if any), else past-end (nothing runs)
    out.push({ type: 'If', test: bin('<', idn(k), num(0)),
      cons: { type: 'Block', body: [assign(k, num(defaultIdx >= 0 ? defaultIdx : LEN))] }, alt: null });
    // one-shot loop; bodies from k onward run (fall-through); `break` exits switch
    const loopBody = clauses.map((c, j) => ({ type: 'If', test: bin('<=', idn(k), num(j)),
      cons: { type: 'Block', body: c.body }, alt: null }));
    out.push({ type: 'For',
      init: { type: 'Let', name: once, value: num(0) },
      test: bin('<', idn(once), num(1)),
      update: assign(once, bin('+', idn(once), num(1))),
      body: { type: 'Block', body: loopBody } });
    return { type: 'Block', body: out };
  }

  function parsePrint() {
    eat('print');
    const value = parseExpr();
    eatOp(';');
    return { type: 'Print', value };
  }

  // ---- expressions ----
  // Grammar: expr -> ternary ; ternary -> binary ('?' expr ':' expr)? .
  function parseExpr() { return parseTernary(); }

  function parseTernary() {
    const cond = parseBinary(0);
    if (atOp('?')) {
      eatOp('?');
      const cons = parseExpr();        // then-branch may itself be a ternary
      eatOp(':');
      const alt = parseExpr();         // right-associative else-branch
      return { type: 'Ternary', test: cond, cons, alt };
    }
    return cond;
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    let op;
    while ((op = curBinOp()) !== null && BINPREC[op] >= minPrec) {
      next();
      const prec = BINPREC[op];
      // '**' is right-associative; everything else left-associative.
      const right = parseBinary(op === '**' ? prec : prec + 1);
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }

  function parseUnary() {
    // prefix ++/-- should be valid in expression position
    if (atOp('++') || atOp('--')) {
      const op = next().value === '++' ? '+' : '-';
      const target = parseUnary();
      return incDec(target, op);
    }
    if (atOp('-') || atOp('!') || atOp('+') || atOp('~')) {
      const op = next().value;
      return { type: 'Unary', op, arg: parseUnary() };
    }
    if (at('typeof') || at('void') || at('delete')) {
      const op = next().type;
      return { type: 'Unary', op, arg: parseUnary() };
    }
    if (at('await')) { next(); return { type: 'Await', arg: parseUnary() }; }
    if (at('yield')) {
      next();
      if (atOp('*')) eatOp('*');
      // yield with no operand (e.g. before `}` or `;`)
      const noArg = atOp(';') || atOp('}') || atOp(')') || atOp(']') || atOp(',') || at('eof');
      const arg = noArg ? { type: 'Null' } : parseUnary();
      return { type: 'Yield', arg };
    }
    return parsePostfix();
  }

  function parseArgs() {
    eatOp('(');
    const args = [];
    if (!atOp(')')) {
      args.push(parseSpreadable());
      while (atOp(',')) { eatOp(','); if (atOp(')')) break; args.push(parseSpreadable()); }
    }
    eatOp(')');
    return args;
  }

  // An argument or array element that may be spread: `...expr`.
  function parseSpreadable() {
    if (atOp('...')) { eatOp('...'); return { type: 'Spread', arg: parseExpr() }; }
    return parseExpr();
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (atOp('(')) {
        node = { type: 'Call', callee: node, args: parseArgs() };
      } else if (atOp('[')) {
        eatOp('[');
        const index = parseExpr();
        eatOp(']');
        node = { type: 'Index', object: node, index };
      } else if (atOp('.')) {
        eatOp('.');
        const property = eatName();
        node = { type: 'Member', object: node, property };
      } else if (atOp('?.')) {
        // optional chaining: lowered to ordinary member/index/call (best effort)
        eatOp('?.');
        if (atOp('(')) { node = { type: 'Call', callee: node, args: parseArgs(), optional: true }; }
        else if (atOp('[')) { eatOp('['); const index = parseExpr(); eatOp(']'); node = { type: 'Index', object: node, index, optional: true }; }
        else { const property = eatName(); node = { type: 'Member', object: node, property, optional: true }; }
      } else break;
    }
    // postfix ++/-- in expression position (e.g. `{ id: db.nextId++ }`, `a[i]++`).
    // Correct old-value semantics via `(L = L +/- 1) -/+ 1`: the assignment leaves
    // the updated value, then we undo the step to yield the original (pre) value.
    if ((atOp('++') || atOp('--')) && (node.type === 'Ident' || node.type === 'Member' || node.type === 'Index')) {
      const op = next().value === '++' ? '+' : '-';
      const undo = op === '+' ? '-' : '+';
      node = { type: 'Binary', op: undo, left: incDec(node, op), right: { type: 'Num', value: 1 } };
    }
    return node;
  }

  // Does the '(' at the cursor open an arrow-function parameter list? Scans to
  // the matching ')' and checks for a following '=>'.
  function looksLikeArrowParen() {
    let depth = 0, j = p;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.type === 'op' && (t.value === '(' || t.value === '[' || t.value === '{')) depth++;
      else if (t.type === 'op' && (t.value === ')' || t.value === ']' || t.value === '}')) {
        depth--; if (depth === 0) { const n = toks[j + 1]; return n && n.type === 'op' && n.value === '=>'; }
      } else if (t.type === 'eof') return false;
    }
    return false;
  }

  function arrowBody(prologue, isAsync, params, renames, restIndex) {
    const block = atOp('{') ? parseBlock() : { type: 'Block', body: [{ type: 'Return', value: parseExpr() }] };
    return { type: 'FnExpr', name: null, params, body: withPrologue(prologue, block, renames), async: isAsync, generator: false, restParam: restIndex };
  }

  // In an object literal, is the modifier word at the cursor actually the key?
  function objMemberEnd(off) {
    const n = toks[p + off];
    return n && n.type === 'op' && (n.value === ':' || n.value === '(' || n.value === ',' || n.value === '}');
  }

  function parsePrimary() {
    // Single-parameter arrow with a name-like parameter, including keyword-alias
    // tokens used as identifiers (e.g. `fn => …`, `of => …`). Must run before the
    // `fn`/keyword handling so `fn` is treated as a parameter, not `function`.
    // No literal is ever followed by `=>`, so this is unambiguous.
    {
      const t0 = toks[p], t1 = toks[p + 1];
      if (t0 && t0.type !== 'ident' && atName() && t1 && t1.type === 'op' && t1.value === '=>') {
        const name = eatName(); eatOp('=>'); return arrowBody([], false, [name]);
      }
    }
    // inline directives in expression position: <@encstr str mode> is a value;
    // other directives (e.g. <@name f>) attach to the following expression.
    if (at('directive')) {
      // value-producing code directives (<@call>, <@if>, <@exists>, <@log>, ...)
      if (CODE_DIRECTIVES.has(peek().value.name)) {
        const node = expandDirectiveExpr(peek().value);
        if (node) { next(); return node; }
      }
      const ds = collectDirectives();
      const rnd = ds.find((d) => d.name === 'random');
      if (rnd) return randomNode(rnd.args[0], rnd.args[1]);
      const enc = ds.find((d) => d.name === 'encstr');
      if (enc) {
        // Two inline forms:
        //   <@encstr "dog" bytecode>            -> encodes the arg string
        //   <@encstr hex>"world"  /  <@encstr hex>EXPR  -> encodes the following string
        const MODES = { hex: 1, str_arr: 1, bytecode: 1, random: 1 };
        let mode = 'random', str = null;
        for (const a of enc.args) { const la = a.toLowerCase(); if (MODES[la]) mode = la; else if (str === null) str = a; }
        if (str === null) { // prefix form: consume the following literal
          if (at('str')) str = next().value;
          else if (at('num')) return encNumNode(next().value); // <@encstr hex>42 -> runtime int
          else if (at('tpl_start')) { /* leave template as-is */ str = ''; }
          else str = '';
        }
        return encStrNode(str, mode);
      }
      const prot = directivesToProt(ds);
      const inner = parsePrimary();
      if (inner.type === 'FnExpr') {
        if (prot.rename) inner.name = prot.rename === '*random*' ? randomName() : prot.rename;
        if (prot.level != null) inner.protLevel = prot.level;
        inner.prot = Object.assign({}, inner.prot, prot);
      }
      return inner;
    }
    const t = peek();
    if (t.type === 'num') { next(); return { type: 'Num', value: t.value }; }
    if (t.type === 'str') { next(); return { type: 'Str', value: t.value }; }
    if (t.type === 'regex') { next(); return { type: 'Regex', pattern: t.value.pattern, flags: t.value.flags || '' }; }
    if (t.type === 'true') { next(); return { type: 'Bool', value: true }; }
    if (t.type === 'false') { next(); return { type: 'Bool', value: false }; }
    if (t.type === 'null') { next(); return { type: 'Null' }; }
    if (t.type === 'ident') {
      // arrow function shorthand: `x => expr`
      if (toks[p+1] && toks[p+1].type === 'op' && toks[p+1].value === '=>') {
        const name = next().value; // consume ident
        eatOp('=>');
        return arrowBody([], false, [name]);
      }
      next();
      return { type: 'Ident', name: t.value };
    }
    // template literal
    if (t.type === 'tpl_start') {
      next(); // consume tpl_start
      const parts = [];
      while (!at('tpl_end')) {
        if (at('str')) { parts.push({ type: 'Str', value: next().value }); continue; }
        if (at('tpl_expr_start')) { next(); // consume start
          // parse an expression until tpl_expr_end appears
          const expr = parseExpr();
          if (!at('tpl_expr_end')) throw new SyntaxError('Unterminated template expression');
          next(); // consume tpl_expr_end
          parts.push(expr);
          continue;
        }
        // unexpected token inside template
        throw new SyntaxError(`Unexpected token in template: ${peek().type}`);
      }
      eat('tpl_end');
      return { type: 'Template', parts };
    }

    // async arrow / async function expression
    if (t.type === 'async') {
      if (toks[p+1] && toks[p+1].type === 'op' && toks[p+1].value === '(') {
        const save = p; next(); // consume async
        if (looksLikeArrowParen()) { const { names, prologue, renames, restIndex } = parseParamList(); eatOp('=>'); return arrowBody(prologue, true, names, renames, restIndex); }
        p = save;
      }
      if (toks[p+1] && toks[p+1].type === 'ident' && toks[p+2] && toks[p+2].type === 'op' && toks[p+2].value === '=>') {
        next(); const name = eatName(); eatOp('=>'); return arrowBody([], true, [name]);
      }
      if (toks[p+1] && toks[p+1].type === 'fn') return parseFnExpr();
    }
    // class expression
    if (t.type === 'class') return parseClass(true);
    // super (best-effort placeholder; resolved at runtime where possible)
    if (t.type === 'super') { next(); return { type: 'Super' }; }
    // `new` expressions
    if (t.type === 'new') {
      next();
      if (atOp('.')) { eatOp('.'); eatName(); return { type: 'Null' }; } // new.target
      const callee = parsePrimary();
      let args = [];
      if (atOp('(')) args = parseArgs();
      return { type: 'New', callee, args };
    }
    if (atOp('(')) {
      if (looksLikeArrowParen()) {
        const { names, prologue, renames, restIndex } = parseParamList();
        eatOp('=>');
        return arrowBody(prologue, false, names, renames, restIndex);
      }
      eatOp('('); const e = parseExpr(); eatOp(')'); return e;
    }
    if (atOp('[')) {
      eatOp('[');
      const elements = [];
      while (!atOp(']')) {
        if (atOp(',')) { elements.push(null); eatOp(','); continue; } // hole
        elements.push(parseSpreadable());
        if (atOp(',')) eatOp(','); else break;
      }
      eatOp(']');
      return { type: 'Array', elements };
    }
    // object / map literal
    if (atOp('{')) {
      eatOp('{');
      const props = [];
      while (!atOp('}')) {
        if (atOp('...')) { eatOp('...'); props.push({ spread: parseExpr() }); if (atOp(',')) eatOp(','); continue; }
        let isAsync = false, isGen = false, kind = 'init';
        if (at('async') && !objMemberEnd(1)) { next(); isAsync = true; }
        if (atOp('*')) { eatOp('*'); isGen = true; }
        if ((at('ident', 'get') || at('ident', 'set')) && !objMemberEnd(1)) { kind = next().value; }
        let computed = false, key = null, keyNode = null;
        if (atOp('[')) { computed = true; eatOp('['); keyNode = parseExpr(); eatOp(']'); }
        else if (at('str')) key = next().value;
        else if (at('num')) key = String(next().value);
        else key = eatName();
        if (atOp('(')) { // method / getter / setter
          const { names, prologue, renames, restIndex } = parseParamList();
          const block = parseBlock();
          const fn = { type: 'FnExpr', name: null, params: names, body: withPrologue(prologue, block, renames), async: isAsync, generator: isGen, restParam: restIndex };
          props.push({ key, keyNode, computed, value: fn, kind: (kind === 'init' ? 'init' : kind) });
        } else if (kind === 'get' || kind === 'set') { // `get`/`set` used as an ordinary key
          if (atOp(':')) { eatOp(':'); props.push({ key: kind, value: parseExpr() }); }
          else props.push({ key: kind, value: { type: 'Ident', name: kind } });
        } else if (atOp(':')) {
          eatOp(':'); props.push({ key, keyNode, computed, value: parseExpr() });
        } else { // shorthand { name }
          props.push({ key, value: { type: 'Ident', name: key } });
        }
        if (atOp(',')) eatOp(','); else break;
      }
      eatOp('}');
      return { type: 'Object', props };
    }
    // anonymous function expression: fn (params) { body }  /  function (...) {...}
    if (t.type === 'fn' && fnIsFunctionExpr()) return parseFnExpr();
    // `fn` used as an ordinary identifier (common in .js input)
    if (t.type === 'fn') { next(); return { type: 'Ident', name: t.value }; }
    if (t.type === 'async' && toks[p+1] && toks[p+1].type === 'fn') return parseFnExpr();
    // any remaining keyword used as a bare identifier (best-effort tolerance)
    if (typeof t.value === 'string' && /^[A-Za-z_$]/.test(t.value)) { next(); return { type: 'Ident', name: t.value }; }
    throw new SyntaxError(`Unexpected token '${t.value}' (${t.type}) at line ${t.line}`);
  }

  return parseProgram();
}

module.exports = { parse };
