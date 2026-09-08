'use strict';
// Lowers an opcode's portable `sem` micro-op tree (src/core/spec.js) to a target
// language's handler source. One generator per language; both consume the exact
// same tree, so JS and Lua handlers can never diverge from the spec. Each handler
// references a facade `F` that the target's machine provides (push/pop/add/...).

const BIN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', eq: 'eq', lt: 'lt' };

// ---- JavaScript ----
function jsExpr(e) {
  switch (e[0]) {
    case 'pop': return 'F.pop()';
    case 'peek': return 'F.peek()';
    case 'u16': return 'F.u16()';
    case 'u8': return 'F.u8()';
    case 'const': return 'F.getConst(' + jsExpr(e[1]) + ')';
    case 'local': return 'F.getLocal(' + jsExpr(e[1]) + ')';
    case 'lit': return JSON.stringify(e[1]);
    case 'var': return e[1];
    case 'bin': return 'F.' + BIN[e[1]] + '(' + jsExpr(e[2]) + ', ' + jsExpr(e[3]) + ')';
    case 'neg': return 'F.neg(' + jsExpr(e[1]) + ')';
    case 'not': return '(!(' + jsExpr(e[1]) + '))';
    case 'truthy': return 'F.truthy(' + jsExpr(e[1]) + ')';
    case 'fcall': return 'F.' + e[1] + '(' + e[2].map(jsExpr).join(', ') + ')'; // generic facade call
    default: throw new Error('js codegen: unknown expr ' + e[0]);
  }
}
function jsStmt(s) {
  switch (s[0]) {
    case 'let': return 'var ' + s[1] + ' = ' + jsExpr(s[2]) + ';';
    case 'push': return 'F.push(' + jsExpr(s[1]) + ');';
    case 'do': return jsExpr(s[1]) + ';';
    case 'setlocal': return 'F.setLocal(' + jsExpr(s[1]) + ', ' + jsExpr(s[2]) + ');';
    case 'setip': return 'F.setIp(' + jsExpr(s[1]) + ');';
    case 'print': return 'F.print(' + jsExpr(s[1]) + ');';
    case 'halt': return 'F.halt();';
    case 'ret': return 'F.ret();';
    case 'call': return 'F.call(' + jsExpr(s[1]) + ', ' + jsExpr(s[2]) + ');';
    case 'if': return 'if (' + jsExpr(s[1]) + ') { ' + s[2].map(jsStmt).join(' ') + ' }';
    default: throw new Error('js codegen: unknown stmt ' + s[0]);
  }
}
function jsBody(sem) { return sem.map(jsStmt).join(' '); }
// a whole handler as a JS function-expression source
function jsHandler(sem) { return 'function (F) { ' + jsBody(sem) + ' }'; }

// ---- Lua ----
function luaExpr(e) {
  switch (e[0]) {
    case 'pop': return 'F.pop()';
    case 'peek': return 'F.peek()';
    case 'u16': return 'F.u16()';
    case 'u8': return 'F.u8()';
    case 'const': return 'F.getConst(' + luaExpr(e[1]) + ')';
    case 'local': return 'F.getLocal(' + luaExpr(e[1]) + ')';
    case 'lit': return e[1] === null ? 'NULL' : (e[1] === true ? 'true' : (e[1] === false ? 'false' : String(e[1])));
    case 'var': return e[1];
    case 'bin': return 'F.' + BIN[e[1]] + '(' + luaExpr(e[2]) + ', ' + luaExpr(e[3]) + ')';
    case 'neg': return 'F.neg(' + luaExpr(e[1]) + ')';
    case 'not': return '(not (' + luaExpr(e[1]) + '))';
    case 'truthy': return 'F.truthy(' + luaExpr(e[1]) + ')';
    case 'fcall': return 'F.' + e[1] + '(' + e[2].map(luaExpr).join(', ') + ')';
    default: throw new Error('lua codegen: unknown expr ' + e[0]);
  }
}
function luaStmt(s) {
  switch (s[0]) {
    case 'let': return 'local ' + s[1] + ' = ' + luaExpr(s[2]);
    case 'push': return 'F.push(' + luaExpr(s[1]) + ')';
    case 'do': return luaExpr(s[1]); // all `do` payloads are facade calls -> valid Lua statements
    case 'setlocal': return 'F.setLocal(' + luaExpr(s[1]) + ', ' + luaExpr(s[2]) + ')';
    case 'setip': return 'F.setIp(' + luaExpr(s[1]) + ')';
    case 'print': return 'F.print(' + luaExpr(s[1]) + ')';
    case 'halt': return 'F.halt()';
    case 'ret': return 'F.ret()';
    case 'call': return 'F.call(' + luaExpr(s[1]) + ', ' + luaExpr(s[2]) + ')';
    case 'if': return 'if ' + luaExpr(s[1]) + ' then ' + s[2].map(luaStmt).join('; ') + ' end';
    default: throw new Error('lua codegen: unknown stmt ' + s[0]);
  }
}
function luaBody(sem) { return sem.map(luaStmt).join('; '); }

// ---- Python ----
// Python can't `;`-join a compound `if`, so a handler lowers to a LIST of lines
// (the caller indents them under `def _h(F):`). Same `sem`, same facade `F` --
// a third target language with zero hand-written, drift-prone semantics.
function pyExpr(e) {
  switch (e[0]) {
    case 'pop': return 'F.pop()';
    case 'peek': return 'F.peek()';
    case 'u16': return 'F.u16()';
    case 'u8': return 'F.u8()';
    case 'const': return 'F.getConst(' + pyExpr(e[1]) + ')';
    case 'local': return 'F.getLocal(' + pyExpr(e[1]) + ')';
    case 'lit': return e[1] === null ? 'NULL' : (e[1] === true ? 'True' : (e[1] === false ? 'False' : String(e[1])));
    case 'var': return e[1];
    case 'bin': return 'F.' + BIN[e[1]] + '(' + pyExpr(e[2]) + ', ' + pyExpr(e[3]) + ')';
    case 'neg': return 'F.neg(' + pyExpr(e[1]) + ')';
    case 'not': return '(not (' + pyExpr(e[1]) + '))';
    case 'truthy': return 'F.truthy(' + pyExpr(e[1]) + ')';
    case 'fcall': return 'F.' + e[1] + '(' + e[2].map(pyExpr).join(', ') + ')';
    default: throw new Error('py codegen: unknown expr ' + e[0]);
  }
}
function pyStmtLines(s) {
  switch (s[0]) {
    case 'let': return [s[1] + ' = ' + pyExpr(s[2])];
    case 'push': return ['F.push(' + pyExpr(s[1]) + ')'];
    case 'do': return [pyExpr(s[1])];
    case 'setlocal': return ['F.setLocal(' + pyExpr(s[1]) + ', ' + pyExpr(s[2]) + ')'];
    case 'setip': return ['F.setIp(' + pyExpr(s[1]) + ')'];
    case 'print': return ['F.print(' + pyExpr(s[1]) + ')'];
    case 'halt': return ['F.halt()'];
    case 'ret': return ['F.ret()'];
    case 'call': return ['F.call(' + pyExpr(s[1]) + ', ' + pyExpr(s[2]) + ')'];
    case 'if': {
      const inner = [].concat(...s[2].map(pyStmtLines));
      return ['if ' + pyExpr(s[1]) + ':'].concat(inner.map((l) => '    ' + l));
    }
    default: throw new Error('py codegen: unknown stmt ' + s[0]);
  }
}
// returns an array of source lines (no leading indent); [] -> caller emits `pass`
function pyLines(sem) { return [].concat(...sem.map(pyStmtLines)); }

module.exports = { jsBody, jsHandler, luaBody, pyLines };
