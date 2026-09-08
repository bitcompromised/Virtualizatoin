function sort(a){ let n = len(a); for (let i = 0; i < n; i = i + 1) { for (let j = 0; j < n - 1; j = j + 1) { if (a[j] > a[j+1]) { let t = a[j]; a[j] = a[j+1]; a[j+1] = t; } } } return a; }
print sort([5, 2, 8, 1, 9, 3]);
