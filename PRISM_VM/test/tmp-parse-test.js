const { compile } = require('../src/compiler');
const { interpret } = require('../src/interp');

const src = `fn outer() {



  let x = 1;


  let inner = fn(inner) { x = x + 1; return x; };




  let f = inner;





  return f();
}`;

const prog = compile(src, { useEnvObjects: true });


console.log(JSON.stringify(prog.functions.map(f=>({name:f.name,upvals:f.upvals})), null, 2));
 
// interpret() is async (top-level await is supported in the language runtime),
// so resolve the promise before logging its output.
interpret(prog).then((out) => console.log(out.output));