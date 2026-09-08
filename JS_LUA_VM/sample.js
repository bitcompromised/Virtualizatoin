function <@split>greet(name) {
  const greeting = "Hello, " + name + "!"; // build message
  return greeting;
}
<@bogus 10>
function factoriala(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result = result * i;
  }
  return result;
}
<@virtualization max>
function factorialb(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result = result * i;
  }
  return result;
}

const <@name testtwo>secret = "top-secret-token-44";
var test = 5+7;
test += 9;
console.log( greet(<@encstr MuaHaHaHaHaHa hex>), factoriala(5), secret);
