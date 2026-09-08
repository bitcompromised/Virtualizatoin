# Runtime value model & memory management

This document is the single source of truth for how values are represented at
runtime and how their memory is managed. The reference interpreter
([`src/interp.js`](../src/interp.js)) and both emitted back-ends
([`src/emit-js.js`](../src/emit-js.js), [`src/emit-lua.js`](../src/emit-lua.js))
implement exactly this model, which is why they produce bit-identical output.

## Values

| Value    | JS representation                     | Lua representation                          |
|----------|---------------------------------------|---------------------------------------------|
| number   | `number` (IEEE-754 double)            | `number`                                    |
| string   | `string`                              | `string`                                    |
| boolean  | `true` / `false`                      | `true` / `false`                            |
| null     | `null`                                | `NULL` sentinel table                       |
| array    | `Array`                               | `{ __arr=true, n, [0..n-1] }`               |
| object   | `VMObj { keys[], map }`               | `{ __obj=true, keys={n,...}, map={} }`      |
| closure  | `{ __closure, fn, upvals }`           | `{ __closure=true, fn, upvals }`            |
| cell     | `{ v }`                               | `{ v }`                                      |

- **Arrays** are dense, 0-indexed, and length-tracked (`n`). Object keys are
  always coerced to strings and preserve insertion order for `str(obj)`.
- **Cells** are the boxing layer for locals. *Every* local variable lives in a
  cell so that a closure capturing it shares the same cell — mutations are
  visible to the enclosing function and every closure over that variable, and
  the variable survives after the defining function returns (see Closures).
- **Closures** hold the target function index plus an array of captured upvalue
  cells. Upvalue descriptors (`fromLocal`, `index`) are resolved at compile time
  and serialized per function in the image.

## Equality & truthiness

- `==` / `!=` are identity for arrays, objects and closures (reference equality),
  and value equality for numbers, strings, booleans and null.
- Falsy values: `null`, `false`, `0`, `""`. Everything else — including empty
  arrays and objects — is truthy.

## Memory management: host GC (decision)

vm-gen **delegates memory management to the host runtime's garbage collector**
(V8 for JavaScript, the Lua GC for Lua). We evaluated the alternatives:

- **Reference counting** — deterministic, but cannot reclaim the reference cycles
  that closures-over-shared-cells and object graphs naturally create, and would
  need a cycle collector anyway.
- **Mark-and-sweep in the VM** — redundant: both host runtimes already ship a
  well-tuned tracing collector, and running a second one over host-allocated
  objects would be slower and more error-prone.
- **Host GC (chosen)** — every VM value *is* a host value, so the host collector
  already traces the operand stack, call frames, local cells, upvalues, arrays
  and objects. Closures keep their captured cells alive for exactly as long as
  they are reachable, which is precisely the required semantics.

The one explicit piece of bookkeeping the VM keeps is the array **length** (`n`),
because both hosts distinguish "absent" from "present but null" differently than
the language does. There is no manual free, no finalizer, and no ownership
transfer in the bytecode; lifetime is reachability, as in the source languages.
