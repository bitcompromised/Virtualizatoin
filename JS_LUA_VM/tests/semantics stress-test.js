"use strict";

const tests = [];
<@virtualization max><@bogus 10><@split>
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------
// Type coercion
// ---------------------------------------------------------

test("String + Number coercion", () => {
  if ("5" + 2 !== "52") {
    throw new Error(`Expected "52"`);
  }
});

test("Number conversion", () => {
  if (Number("123") !== 123) {
    throw new Error("Number conversion failed");
  }
});

test("Boolean conversion", () => {
  if (Boolean(0) !== false) throw new Error("0 should be false");
  if (Boolean(1) !== true) throw new Error("1 should be true");
  if (Boolean("") !== false) throw new Error("empty string should be false");
});

// ---------------------------------------------------------
// Equality
// ---------------------------------------------------------

test("Strict equality", () => {
  if (1 !== 1) throw new Error("1 !== 1");
  if (1 === "1") throw new Error("1 === '1'");
});

test("NaN", () => {
  if (NaN === NaN) {
    throw new Error("NaN should not equal itself");
  }

  if (!Number.isNaN(NaN)) {
    throw new Error("Number.isNaN failed");
  }
});

test("Object.is", () => {
  if (!Object.is(NaN, NaN)) {
    throw new Error("Object.is(NaN, NaN) failed");
  }

  if (Object.is(0, -0)) {
    throw new Error("Object.is(0, -0) should be false");
  }
});

// ---------------------------------------------------------
// Hoisting / TDZ
// ---------------------------------------------------------

test("var hoisting", () => {
  if (typeof value !== "undefined") {
    throw new Error("var should be hoisted");
  }

  var value = 123;
});

test("let block scope", () => {
  let value = "outer";

  {
    let value = "inner";

    if (value !== "inner") {
      throw new Error("inner binding incorrect");
    }
  }

  if (value !== "outer") {
    throw new Error("outer binding modified");
  }
});

// ---------------------------------------------------------
// Functions
// ---------------------------------------------------------

test("Function call", () => {
  function add(a, b) {
    return a + b;
  }

  if (add(2, 3) !== 5) {
    throw new Error("add failed");
  }
});

test("Function arguments", () => {
  function collect() {
    return [...arguments].join(",");
  }

  if (collect(1, 2, 3) !== "1,2,3") {
    throw new Error("arguments failed");
  }
});

test("Rest parameters", () => {
  function sum(...values) {
    return values.reduce((a, b) => a + b, 0);
  }

  if (sum(1, 2, 3, 4) !== 10) {
    throw new Error("rest parameters failed");
  }
});

test("bind", () => {
  const object = { value: 42 };

  function getValue() {
    return this.value;
  }

  const bound = getValue.bind(object);

  if (bound() !== 42) {
    throw new Error("bind failed");
  }
});

// ---------------------------------------------------------
// Recursion
// ---------------------------------------------------------

test("Recursion", () => {
  function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
  }

  if (factorial(10) !== 3628800) {
    throw new Error("factorial failed");
  }
});

// ---------------------------------------------------------
// Objects
// ---------------------------------------------------------

test("Property access", () => {
  const obj = {
    a: 10,
    b: 20,
  };

  if (obj.a + obj.b !== 30) {
    throw new Error("property access failed");
  }
});

test("Getter", () => {
  const obj = {
    value: 42,

    get doubled() {
      return this.value * 2;
    },
  };

  if (obj.doubled !== 84) {
    throw new Error("getter failed");
  }
});

test("Setter", () => {
  let stored;

  const obj = {
    set value(v) {
      stored = v;
    },
  };

  obj.value = 123;

  if (stored !== 123) {
    throw new Error("setter failed");
  }
});

test("Property descriptors", () => {
  const obj = {};

  Object.defineProperty(obj, "value", {
    value: 42,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  if (obj.value !== 42) {
    throw new Error("property value incorrect");
  }

  if (Object.keys(obj).includes("value")) {
    throw new Error("non-enumerable property appeared");
  }
});

// ---------------------------------------------------------
// Prototype behavior
// ---------------------------------------------------------

test("Prototype inheritance", () => {
  const parent = {
    value: 42,
  };

  const child = Object.create(parent);

  if (child.value !== 42) {
    throw new Error("prototype lookup failed");
  }
});

test("Prototype shadowing", () => {
  const parent = {
    value: 10,
  };

  const child = Object.create(parent);
  child.value = 20;

  if (child.value !== 20) {
    throw new Error("shadowing failed");
  }

  if (parent.value !== 10) {
    throw new Error("parent was modified");
  }
});

// ---------------------------------------------------------
// Arrays
// ---------------------------------------------------------

test("Array methods", () => {
  const values = [1, 2, 3];

  const result = values
    .map(x => x * 2)
    .filter(x => x > 2)
    .reduce((a, b) => a + b, 0);

  if (result !== 10) {
    throw new Error("array pipeline failed");
  }
});

test("Sparse arrays", () => {
  const array = [];

  array[3] = "x";

  if (array.length !== 4) {
    throw new Error("sparse array length incorrect");
  }

  if (array[0] !== undefined) {
    throw new Error("missing element incorrect");
  }
});

// ---------------------------------------------------------
// Destructuring
// ---------------------------------------------------------

test("Object destructuring", () => {
  const { a, b } = {
    a: 10,
    b: 20,
  };

  if (a !== 10 || b !== 20) {
    throw new Error("object destructuring failed");
  }
});

test("Array destructuring", () => {
  const [a, , c] = [1, 2, 3];

  if (a !== 1 || c !== 3) {
    throw new Error("array destructuring failed");
  }
});

// ---------------------------------------------------------
// Iterators
// ---------------------------------------------------------

test("for...of", () => {
  let total = 0;

  for (const value of [1, 2, 3, 4]) {
    total += value;
  }

  if (total !== 10) {
    throw new Error("for...of failed");
  }
});

test("Custom iterator", () => {
  const iterable = {
    *[Symbol.iterator]() {
      yield 10;
      yield 20;
      yield 30;
    },
  };

  const values = [...iterable];

  if (values.join(",") !== "10,20,30") {
    throw new Error("custom iterator failed");
  }
});

// ---------------------------------------------------------
// Classes
// ---------------------------------------------------------

test("Class constructor", () => {
  class Person {
    constructor(name) {
      this.name = name;
    }
  }

  const person = new Person("Alice");

  if (person.name !== "Alice") {
    throw new Error("constructor failed");
  }
});

test("Class inheritance", () => {
  class Animal {
    speak() {
      return "sound";
    }
  }

  class Dog extends Animal {
    speak() {
      return "bark";
    }
  }

  const dog = new Dog();

  if (dog.speak() !== "bark") {
    throw new Error("method override failed");
  }

  if (!(dog instanceof Animal)) {
    throw new Error("instanceof inheritance failed");
  }
});

// ---------------------------------------------------------
// Exceptions
// ---------------------------------------------------------

test("try/catch", () => {
  let caught = false;

  try {
    throw new Error("boom");
  } catch (error) {
    caught = error.message === "boom";
  }

  if (!caught) {
    throw new Error("catch failed");
  }
});

test("finally", () => {
  let executed = false;

  try {
    throw new Error("test");
  } catch {
    // expected
  } finally {
    executed = true;
  }

  if (!executed) {
    throw new Error("finally did not execute");
  }
});

// ---------------------------------------------------------
// Promises
// ---------------------------------------------------------

test("Promise resolution", async () => {
  const value = await Promise.resolve(42);

  if (value !== 42) {
    throw new Error("Promise resolution failed");
  }
});

test("Promise chaining", async () => {
  const value = await Promise.resolve(2)
    .then(x => x * 2)
    .then(x => x + 10);

  if (value !== 14) {
    throw new Error("Promise chaining failed");
  }
});

// ---------------------------------------------------------
// Proxy
// ---------------------------------------------------------

test("Proxy get trap", () => {
  const target = {
    value: 10,
  };

  const proxy = new Proxy(target, {
    get(target, property) {
      if (property === "value") {
        return target[property] * 2;
      }

      return target[property];
    },
  });

  if (proxy.value !== 20) {
    throw new Error("Proxy failed");
  }
});

// ---------------------------------------------------------
// Map / Set
// ---------------------------------------------------------

test("Map", () => {
  const map = new Map();

  map.set("answer", 42);

  if (map.get("answer") !== 42) {
    throw new Error("Map get failed");
  }

  if (!map.has("answer")) {
    throw new Error("Map has failed");
  }
});

test("Set", () => {
  const set = new Set([1, 2, 2, 3]);

  if (set.size !== 3) {
    throw new Error("Set deduplication failed");
  }
});

// ---------------------------------------------------------
// BigInt
// ---------------------------------------------------------

test("BigInt arithmetic", () => {
  const value = 1000000000000000000n;

  if (value * 2n !== 2000000000000000000n) {
    throw new Error("BigInt multiplication failed");
  }
});

// ---------------------------------------------------------
// Run
// ---------------------------------------------------------

async function <@virtualization max><@split>main() {
  let passed = 0;
  let failed = 0;

  console.log(`Running ${tests.length} semantic tests...\n`);

  for (const { name, fn } of tests) {
    try {
      await fn();

      console.log(`PASS  ${name}`);
      passed++;
    } catch (error) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${error.message}`);
      failed++;
    }
  }

  console.log("\n==============================");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${tests.length}`);
  console.log("==============================");

  process.exitCode = failed === 0 ? 0 : 1;
}

main();
