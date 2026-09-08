function fib(n){ if (n < 2) { return n; } return fib(n-1) + fib(n-2); }
let i = 0;
while (i < 10) { console.log("fib(" + i + ") = " + fib(i)); i = i + 1; }
