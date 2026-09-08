const { compile } = require('../src/compiler');
const { interpret } = require('../src/interp');
const src = 'try { throw 3; } catch (e) { print(e); }';
const prog = compile(src);
console.log(JSON.stringify(prog.functions.map(f=>({name:f.name,handlers:f.handlers})),null,2));
interpret(prog).then((out) => console.log(out.output));
