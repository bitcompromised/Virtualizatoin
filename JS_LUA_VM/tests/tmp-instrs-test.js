const { compile } = require('../src/compiler');
const prog = compile('fn outer(){ let x=1; let inner = fn(){ x = x + 1; return x; }; let f=inner; return f(); } print(outer());', {useEnvObjects:true});
console.log(JSON.stringify(prog.functions.map(f=>f.instrs.map(i=>({op:i.op,args:i.args}))), null,2));
