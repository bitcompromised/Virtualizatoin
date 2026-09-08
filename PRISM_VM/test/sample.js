function greet(name) {
  const greeting = "Hello, " + name + "!"; // build message
  return greeting;
}

function factoriala(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result = result * i;
  }
  return result;
}

function factorialb(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result = result * i;
  }
  return result;
}

const secret = "top-secret-token-44";
var test = 5+7;
test += 9;

console.log(greet('hmm'), 5, 4,factoriala(5), 3, 2, 1, secret);
console.log(1, 2, 3, 4, factoriala(5), secret);
