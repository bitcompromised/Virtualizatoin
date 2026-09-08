const os = require("os");
const fs = require("fs");

console.log({
  hostname: os.hostname(),
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  node: process.version,
  uptime: os.uptime(),
  cpuCount: os.cpus().length,
  memoryTotalGB: (os.totalmem() / 1024 ** 3).toFixed(2),
  memoryFreeGB: (os.freemem() / 1024 ** 3).toFixed(2),
  loadAverage: os.loadavg(),
});

try {
  console.log("\n/etc/os-release:");
  console.log(fs.readFileSync("/etc/os-release", "utf8"));
} catch {}
