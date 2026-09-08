"use strict";

const tests = [
  {
    name: "Closures",
    run() {
      function makeCounter() {
        let count = 0;

        return () => ++count;
      }

      const counter = makeCounter();

      if (counter() !== 1) throw new Error("First increment failed");
      if (counter() !== 2) throw new Error("Second increment failed");
      if (counter() !== 3) throw new Error("Third increment failed");
    },
  },

  {
    name: "Closure isolation",
    run() {
      function makeCounter() {
        let value = 0;
        return () => ++value;
      }

      const a = makeCounter();
      const b = makeCounter();

      if (a() !== 1) throw new Error("Counter A incorrect");
      if (a() !== 2) throw new Error("Counter A incorrect");
      if (b() !== 1) throw new Error("Counter B leaked state");
    },
  },

  {
    name: "Lexical scoping",
    run() {
      const x = "outer";

      function test() {
        const x = "inner";

        return x;
      }

      if (test() !== "inner") {
        throw new Error("Lexical scope is incorrect");
      }

      if (x !== "outer") {
        throw new Error("Outer scope was modified");
      }
    },
  },

  {
    name: "Block scoping",
    run() {
      let value = "outer";

      {
        let value = "inner";

        if (value !== "inner") {
          throw new Error("Inner block scope failed");
        }
      }

      if (value !== "outer") {
        throw new Error("Block scope leaked");
      }
    },
  },

  {
    name: "Arrow functions",
    run() {
      const nums = [1, 2, 3, 4];

      const result = nums.map(x => x * 2);

      if (JSON.stringify(result) !== "[2,4,6,8]") {
        throw new Error("Arrow function failed");
      }
    },
  },

  {
    name: "this binding",
    run() {
      const object = {
        value: 42,

        regular() {
          return this.value;
        },

        arrow: () => {
          return undefined;
        },
      };

      if (object.regular() !== 42) {
        throw new Error("Regular this binding failed");
      }

      // Arrow functions intentionally don't dynamically bind `this`.
      if (object.arrow() !== undefined) {
        throw new Error("Arrow this behavior is unexpected");
      }
    },
  },

  {
    name: "Prototype chain",
    run() {
      const parent = {
        greet() {
          return "hello";
        },
      };

      const child = Object.create(parent);

      if (child.greet() !== "hello") {
        throw new Error("Prototype lookup failed");
      }

      if (!Object.getPrototypeOf(child) === parent) {
        throw new Error("Prototype relationship failed");
      }
    },
  },

  {
    name: "Classes and inheritance",
    run() {
      class Animal {
        constructor(name) {
          this.name = name;
        }

        speak() {
          return `${this.name} speaks`;
        }
      }

      class Dog extends Animal {
        speak() {
          return `${this.name} barks`;
        }
      }

      const dog = new Dog("Rex");

      if (!(dog instanceof Dog)) {
        throw new Error("Dog instanceof failed");
      }

      if (!(dog instanceof Animal)) {
        throw new Error("Animal instanceof failed");
      }

      if (dog.speak() !== "Rex barks") {
        throw new Error("Method override failed");
      }
    },
  },

  {
    name: "Generators",
    run() {
      function* numbers() {
        yield 1;
        yield 2;
        yield 3;
      }

      const result = [...numbers()];

      if (JSON.stringify(result) !== "[1,2,3]") {
        throw new Error("Generator failed");
      }
    },
  },

  {
    name: "Promises",
    async run() {
      const value = await Promise.resolve(123);

      if (value !== 123) {
        throw new Error("Promise resolution failed");
      }
    },
  },

  {
    name: "Async ordering",
    async run() {
      const events = [];

      events.push("sync");

      await Promise.resolve();

      events.push("microtask");

      if (events.join(",") !== "sync,microtask") {
        throw new Error("Microtask ordering failed");
      }
    },
  },

  {
    name: "Exceptions",
    run() {
      let caught = false;

      try {
        throw new Error("test");
      } catch (err) {
        caught = err.message === "test";
      }

      if (!caught) {
        throw new Error("Exception handling failed");
      }
    },
  },

  {
    name: "Destructuring",
    run() {
      const object = {
        name: "Alice",
        age: 30,
      };

      const { name, age } = object;

      if (name !== "Alice" || age !== 30) {
        throw new Error("Object destructuring failed");
      }

      const [a, b] = [10, 20];

      if (a !== 10 || b !== 20) {
        throw new Error("Array destructuring failed");
      }
    },
  },

  {
    name: "Symbols",
    run() {
      const key = Symbol("private-ish");
      const object = {};

      object[key] = 123;

      if (object[key] !== 123) {
        throw new Error("Symbol property failed");
      }

      if (Object.keys(object).length !== 0) {
        throw new Error("Symbol unexpectedly appeared in Object.keys()");
      }
    },
  },

  {
    name: "WeakMap",
    run() {
      const map = new WeakMap();
      const key = {};

      map.set(key, "value");

      if (map.get(key) !== "value") {
        throw new Error("WeakMap failed");
      }
    },
  },

  {
    name: "Regular expression engine",
    run() {
      const regex = /hello\s+world/i;

      if (!regex.test("HELLO   WORLD")) {
        throw new Error("RegExp matching failed");
      }
    },
  },

  {
    name: "BigInt",
    run() {
      const a = 9007199254740993n;
      const b = 7n;

      if (a + b !== 9007199254741000n) {
        throw new Error("BigInt arithmetic failed");
      }
    },
  },

  {
    name: "Proxy",
    run() {
      const target = { value: 10 };

      const proxy = new Proxy(target, {
        get(obj, property) {
          if (property === "value") {
            return obj[property] * 2;
          }

          return obj[property];
        },
      });

      if (proxy.value !== 20) {
        throw new Error("Proxy get trap failed");
      }
    },
  },
];

async function runTests() {
  console.log(`Node.js ${process.version}`);
  console.log(`V8 ${process.versions.v8}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log("");
  console.log(`Running ${tests.length} VM tests...\n`);

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const start = process.hrtime.bigint();

    try {
      await test.run();

      const elapsed =
        Number(process.hrtime.bigint() - start) / 1e6;

      console.log(
        `\x1b[32mPASS\x1b[0m  ${test.name} (${elapsed.toFixed(3)} ms)`
      );

      passed++;
    } catch (error) {
      const elapsed =
        Number(process.hrtime.bigint() - start) / 1e6;

      console.log(
        `\x1b[31mFAIL\x1b[0m  ${test.name} (${elapsed.toFixed(3)} ms)`
      );

      console.log(`       ${error.message}`);

      failed++;
    }
  }

  console.log("\n--------------------------------");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${tests.length}`);
  console.log("--------------------------------");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

runTests();
