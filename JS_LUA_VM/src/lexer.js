'use strict';
// Tokenizer for the vm-gen source language (.vgs).

const KEYWORDS = new Set([
  'let', 'fn', 'return', 'if', 'else', 'while', 'for', 'break', 'continue',
  'print', 'true', 'false', 'null',
  'try', 'catch', 'finally', 'throw',
  // .js-friendly aliases (see KW_ALIAS) so plain JavaScript in the supported
  // subset can be used as input directly.
  'function', 'const', 'var',
  // Common JS keywords supported by the front-end
  'new', 'async', 'await',
  // Broader JS surface (classes, modules, operators). `of`, `from`, `get`, `set`,
  // `static` and `as` stay ordinary identifiers and are recognised contextually
  // by the parser, so code may still use them as names.
  'class', 'extends', 'super', 'typeof', 'instanceof', 'in',
  'void', 'delete', 'yield', 'import', 'export',
]);

// Keyword aliases: these lex to the token type of their canonical keyword so
// the parser needs no special cases. Lets a `.js` file use `function`/`const`.
const KW_ALIAS = { function: 'fn', const: 'let', var: 'let' };

// Multi-char operators first so the longest match wins (the scan below returns
// the first op that matches at the cursor, so 3-char must precede 2-char, etc).
const OPS = [
  '...',
  '>>>=', '>>>',
  '<<=', '>>=', '===', '!==', '**=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--', '**', '?.', '??',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '=>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '?', ':', '.',
  '(', ')', '{', '}', '[', ']', ',', ';',
];

function isIdentStart(c) { return /[A-Za-z_$]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_$]/.test(c); }
function isDigit(c) { return c >= '0' && c <= '9'; }

function lex(src) {
  // Skip a leading shebang line (`#!/usr/bin/env node`), which is legal at the
  // very start of an executable .js file but is not a token.
  if (src.charCodeAt(0) === 0x23 /* # */ && src.charCodeAt(1) === 0x21 /* ! */) {
    const nl = src.indexOf('\n');
    src = nl === -1 ? '' : src.slice(nl); // keep the newline so line numbers stay aligned
  }
  const toks = [];
  let i = 0, line = 1, col = 1;
  const N = src.length;

  // Tracks whether a newline was seen since the previous token, so the parser
  // can treat a line break as an implicit statement terminator (ASI-lite). This
  // makes semicolons optional and removes semicolon-dependent parsing.
  let nlPending = false;
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') { line++; col = 1; nlPending = true; } else { col++; } i++; } };
  const push = (type, value) => { toks.push({ type, value, line, col, nl: nlPending }); nlPending = false; };

  while (i < N) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(); continue; }

    // line comments  //...   and block comments /* ... */
    if (c === '/' && src[i + 1] === '/') { while (i < N && src[i] !== '\n') adv(); continue; }
    if (c === '/' && src[i + 1] === '*') {
      adv(2);
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) adv();
      adv(2);
      continue;
    }

    // inline compiler directive:  <@name arg1 arg2 ...>
    // Emitted as a `directive` token so the parser can attach it to the next
    // statement / function / binding / expression. Checked before the `<`
    // operator; `<@` is unambiguous (no expression starts with `@`).
    if (c === '<' && src[i + 1] === '@') {
      adv(2);
      // Capture the directive body up to the matching '>' at bracket-depth 0, so
      // a body may contain code with '>' comparisons, call args and even a full
      // `{ ... }` function body (e.g. <@fn f(x){ return x>0 }>). String literals
      // are skipped so quoted '>' / brackets do not affect the depth.
      let body = '', depth = 0, dirDepth = 0, q = null;
      while (i < N) {
        const ch = src[i];
        if (q) { body += ch; if (ch === q && src[i - 1] !== '\\') q = null; adv(); continue; }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; body += ch; adv(); continue; }
        if (ch === '<' && src[i + 1] === '@') { dirDepth++; body += '<@'; adv(2); continue; } // nested <@...>
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === '>' && depth <= 0) {
          if (dirDepth > 0) { dirDepth--; body += '>'; adv(); continue; } // close a nested directive
          break; // outer directive terminator
        }
        body += ch; adv();
      }
      if (src[i] === '>') adv();
      const parts = body.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const name = (parts[0] || '').toLowerCase();
      const args = parts.slice(1).map((a) => (/^["']/.test(a) ? a.slice(1, -1) : a));
      // `rest` is the raw body text after the directive name -- used by code
      // directives (<@fn>, <@call>, <@log>, ...) that re-parse it as source.
      const rest = body.trim().replace(/^\S+\s*/, '');
      push('directive', { name, args, body: body.trim(), rest });
      continue;
    }

    // numbers (int, float, exponent, hex, or BigInt literal)
    if (isDigit(c)) {
      let s = '';
      if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        s += src[i]; adv(); s += src[i]; adv();
        while (i < N && /[0-9a-fA-F]/.test(src[i])) { s += src[i]; adv(); }
        if (src[i] === 'n') adv(); // BigInt suffix
        push('num', parseInt(s, 16));
        continue;
      }
      while (i < N && (isDigit(src[i]) || src[i] === '.')) { s += src[i]; adv(); }
      // exponent part, e.g. 1e6 or 1.5e-3
      if (src[i] === 'e' || src[i] === 'E') {
        s += src[i]; adv();
        if (src[i] === '+' || src[i] === '-') { s += src[i]; adv(); }
        while (i < N && isDigit(src[i])) { s += src[i]; adv(); }
      }
      if (src[i] === 'n') adv(); // BigInt suffix: value kept as a Number (best effort)
      push('num', parseFloat(s));
      continue;
    }

    // strings (support single, double and backtick-delimited templates)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; adv();
      // Handle template literals with embedded `${...}` expressions (full nested support).
      if (quote === '`') {
        // emit a tpl_start token then a sequence of str and tpl_expr_start/tpl_expr_end tokens, then tpl_end
        push('tpl_start', null);
        let buf = '';
        while (i < N) {
          if (src.startsWith('`', i)) { // end of template
            if (buf.length) { push('str', buf); buf = ''; }
            adv(); // consume `
            push('tpl_end', null);
            break;
          }
          if (src.startsWith('${', i)) {
            // flush buffer as string token
            if (buf.length) { push('str', buf); buf = ''; }
            adv(2); // consume ${
            push('tpl_expr_start', null);
            // lex inner expression until matching } (track nested braces)
            let braceDepth = 0;
            while (i < N) {
              const ch = src[i];
              if (ch === '\"' || ch === "'" || ch === '`') {
                // reuse string handling inside expression
                const q = ch; adv(); let ss = '';
                while (i < N && src[i] !== q) {
                  if (src[i] === '\\') { adv(); ss += src[i]; adv(); } else { ss += src[i]; adv(); }
                }
                if (src[i] === q) adv(); push('str', ss);
                continue;
              }
              if (ch === '/' && src[i+1] !== '/' && src[i+1] !== '*') {
                // heuristic: handle regex start inside expression
                const n1 = src[i+1];
                if (n1 === '^' || n1 === '[' || n1 === '(' || n1 === '\\') {
                  adv(); let pat = '', esc = false, inClass = false;
                  while (i < N) {
                    const ch2 = src[i];
                    if (!esc && ch2 === '/' && !inClass) break;
                    if (ch2 === '\\' && !esc) { esc = true; pat += ch2; adv(); continue; }
                    if (!esc) { if (ch2 === '[') inClass = true; else if (ch2 === ']') inClass = false; }
                    esc = false; pat += ch2; adv();
                  }
                  if (src[i] === '/') adv(); let flags = ''; while (i < N && /[gimuy]/.test(src[i])) { flags += src[i]; adv(); }
                  push('regex', { pattern: pat, flags: flags });
                  continue;
                }
              }
              if (src[i] === '{') { braceDepth++; push('op', '{'); adv(); continue; }
              if (src[i] === '}') {
                if (braceDepth === 0) { adv(); push('tpl_expr_end', null); break; }
                braceDepth--; push('op', '}'); adv(); continue;
              }
              // reuse main loop's handling for identifiers, numbers, ops etc inside expression
              // whitespace
              if (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') { adv(); continue; }
              // line comments and block comments
              if (src[i] === '/' && src[i+1] === '/') { while (i < N && src[i] !== '\n') adv(); continue; }
              if (src[i] === '/' && src[i+1] === '*') { adv(2); while (i < N && !(src[i] === '*' && src[i+1] === '/')) adv(); adv(2); continue; }
              // numbers
              if (/[0-9]/.test(src[i])) { let s = ''; while (i < N && (/[0-9]/.test(src[i]) || src[i] === '.')) { s += src[i]; adv(); } push('num', parseFloat(s)); continue; }
              // identifiers / keywords
              if (/[A-Za-z_]/.test(src[i])) { let s = ''; while (i < N && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; adv(); } const kw = KEYWORDS.has(s) ? (KW_ALIAS[s] || s) : 'ident'; push(kw, s); continue; }
              // operators
              let matched2 = null;
              for (const op of OPS) { if (src.startsWith(op, i)) { matched2 = op; break; } }
              if (matched2) { push('op', matched2); adv(matched2.length); continue; }
              // anything else: consume char into buffer to avoid infinite loop
              buf += src[i]; adv();
            }
            continue;
          }
          // normal character into buffer, allow escapes
          if (src[i] === '\\') { adv(); if (i < N) { buf += src[i]; adv(); } continue; }
          buf += src[i]; adv();
        }
        continue;
      }

      // non-template single/double quoted string
      let s = '';
      while (i < N && src[i] !== quote) {
        if (src[i] === '\\') {
          adv();
          const e = src[i];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r'
             : e === '\\' ? '\\' : e === quote ? quote : e;
          adv();
        } else { s += src[i]; adv(); }
      }
      // closing quote
      if (src[i] === quote) adv();
      push('str', s);
      continue;
    }

    // protection annotations:  @name   or   <@ name strength >
    if (c === '<' && src[i + 1] === '@') {
      adv(2);
      let content = '';
      while (i < N && src[i] !== '>') { content += src[i]; adv(); }
      adv(); // closing '>'
      push('annot', content.trim());
      continue;
    }
    if (c === '@') {
      adv();
      let s = '';
      while (i < N && isIdentPart(src[i])) { s += src[i]; adv(); }
      push('annot', s);
      continue;
    }

    // identifiers / keywords
    if (isIdentStart(c)) {
      let s = '';
      while (i < N && isIdentPart(src[i])) { s += src[i]; adv(); }
      const kw = KEYWORDS.has(s) ? (KW_ALIAS[s] || s) : 'ident';
      // keep the original spelling as the token value so error messages and
      // `console`/`log` identifiers survive; only the *type* is canonicalized.
      push(kw, s);
      continue;
    }

    // operators and a lightweight regex literal heuristic
    // A leading '/' is a regex only where an expression may *begin*; after a
    // value (identifier, literal, or a closing ')'/']') it is division. This is
    // the standard lex-time disambiguation and keeps `a / b` from being mistaken
    // for a regex while still recognising `x.replace(/re/, ...)`.
    const prevTok = toks[toks.length - 1];
    const regexAllowed = !prevTok || !(
      prevTok.type === 'ident' || prevTok.type === 'num' || prevTok.type === 'str' ||
      prevTok.type === 'regex' || prevTok.type === 'true' || prevTok.type === 'false' ||
      prevTok.type === 'null' || (prevTok.type === 'op' && (prevTok.value === ')' || prevTok.value === ']'))
    );
    if (regexAllowed && c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*') {
      // Scan ahead for an unescaped closing '/', tracking [...] character classes
      // (where '/' is literal) and stopping at a newline (regex literals are
      // single-line). Only if a well-formed literal is found do we emit a regex.
      let j = i + 1; let esc = false; let found = false; let inClass = false;
      while (j < N) {
        const ch = src[j];
        if (ch === '\n') break; // regex literals do not span lines
        if (esc) { esc = false; j++; continue; }
        if (ch === '\\') { esc = true; j++; continue; }
        // '/' inside a [...] character class does not close the literal
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { found = true; break; }
        j++;
      }
      if (found) {
        adv(); // consume '/'
        let pat = '';
        esc = false; inClass = false;
        while (i < N) {
          const ch = src[i];
          if (!esc && ch === '/' && !inClass) break;
          if (ch === '\\' && !esc) { esc = true; pat += ch; adv(); continue; }
          if (!esc) { if (ch === '[') inClass = true; else if (ch === ']') inClass = false; }
          esc = false;
          pat += ch;
          adv();
        }
        if (src[i] === '/') adv(); // closing slash
        // optional flags
        let flags = '';
        while (i < N && /[gimuy]/.test(src[i])) { flags += src[i]; adv(); }
        push('regex', { pattern: pat, flags: flags });
        continue;
      }
    }

    let matched = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) { push('op', matched); adv(matched.length); continue; }
    throw new SyntaxError(`Unexpected character '${c}' at line ${line}:${col}`);
  }

  push('eof', null);
  return toks;
}

module.exports = { lex, KEYWORDS };
