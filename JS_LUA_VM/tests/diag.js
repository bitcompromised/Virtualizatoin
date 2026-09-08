
/**
 * VM Diagnostics
 * ----------------
 * Linux-focused Node.js diagnostic utility.
 *
 * Checks:
 *   - System
 *   - Virtualization
 *   - CPU / CPU steal
 *   - Memory / swap
 *   - Disk / filesystem
 *   - Network / DNS
 *   - Processes
 *   - Node.js runtime
 *   - Resource limits
 *   - Containers
 *
 * Usage:
 *   node vm-diagnostics.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const dns = require("dns").promises;
const net = require("net");
const { performance } = require("perf_hooks");
const v8 = require("v8");

const results = [];

function command(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function section(title) {
  console.log("\n" + "═".repeat(70));
  console.log(` ${title}`);
  console.log("═".repeat(70));
}

function status(label, value, state = "INFO") {
  const colors = {
    PASS: "\x1b[32m",
    WARN: "\x1b[33m",
    FAIL: "\x1b[31m",
    INFO: "\x1b[36m",
  };

  const reset = "\x1b[0m";
  const color = colors[state] || colors.INFO;

  console.log(
    `${color}${state.padEnd(5)}${reset} ${label.padEnd(28)} ${value}`
  );

  results.push({ label, value, state });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bytesToGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function bytesToMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/* ---------------------------------------------------------- */
/* SYSTEM */
/* ---------------------------------------------------------- */

function systemDiagnostics() {
  section("SYSTEM");

  status("Hostname", os.hostname());
  status("OS", `${os.type()} ${os.release()}`);
  status("Architecture", os.arch());
  status("Node.js", process.version);
  status("CPU cores", os.cpus().length);
  status("System uptime", `${(os.uptime() / 86400).toFixed(2)} days`);
  status("Load average", os.loadavg().map(x => x.toFixed(2)).join(" / "));

  const osRelease = readFile("/etc/os-release");

  if (osRelease) {
    const pretty = osRelease.match(/^PRETTY_NAME="?(.+?)"?$/m);

    if (pretty) {
      status("Distribution", pretty[1]);
    }
  }

  status("Kernel", command("uname -r") || "Unknown");
  status("Current user", command("id -un") || "Unknown");

  const tz = command("timedatectl show --property=Timezone --value");

  if (tz) {
    status("Timezone", tz);
  }
}

/* ---------------------------------------------------------- */
/* VIRTUALIZATION */
/* ---------------------------------------------------------- */

function virtualizationDiagnostics() {
  section("VIRTUALIZATION");

  let virtualization = command("systemd-detect-virt");

  if (virtualization === "none") {
    virtualization = null;
  }

  if (!virtualization) {
    const product = readFile("/sys/class/dmi/id/product_name");

    if (product) {
      const lower = product.toLowerCase();

      if (
        lower.includes("kvm") ||
        lower.includes("vmware") ||
        lower.includes("virtualbox") ||
        lower.includes("hyper-v") ||
        lower.includes("xen")
      ) {
        virtualization = product.trim();
      }
    }
  }

  if (virtualization) {
    status("Virtualization", virtualization, "INFO");
  } else {
    status("Virtualization", "Not detected", "INFO");
  }

  const hypervisor = readFile("/sys/hypervisor/type");

  if (hypervisor) {
    status("Hypervisor", hypervisor.trim(), "INFO");
  }

  if (fs.existsSync("/.dockerenv")) {
    status("Docker container", "Detected", "INFO");
  }

  const cgroup = readFile("/proc/1/cgroup");

  if (cgroup && /docker|containerd|kubepods|lxc/i.test(cgroup)) {
    status("Container", "Detected", "INFO");
  }
}

/* ---------------------------------------------------------- */
/* CPU */
/* ---------------------------------------------------------- */

function readCPUStats() {
  const data = readFile("/proc/stat");

  if (!data) return null;

  const line = data
    .split("\n")
    .find(line => line.startsWith("cpu "));

  if (!line) return null;

  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);

  return {
    user: values[0] || 0,
    nice: values[1] || 0,
    system: values[2] || 0,
    idle: values[3] || 0,
    iowait: values[4] || 0,
    irq: values[5] || 0,
    softirq: values[6] || 0,
    steal: values[7] || 0,
  };
}

async function cpuDiagnostics() {
  section("CPU");

  const cpus = os.cpus();

  status("Logical CPUs", cpus.length);

  if (cpus[0]) {
    status("CPU model", cpus[0].model);
    status("Reported speed", `${cpus[0].speed} MHz`);
  }

  const before = readCPUStats();

  await sleep(1000);

  const after = readCPUStats();

  if (before && after) {
    const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
    const totalAfter = Object.values(after).reduce((a, b) => a + b, 0);

    const totalDelta = totalAfter - totalBefore;

    const stealDelta = after.steal - before.steal;
    const stealPercent = (stealDelta / totalDelta) * 100;

    const ioDelta = after.iowait - before.iowait;
    const ioPercent = (ioDelta / totalDelta) * 100;

    status(
      "CPU steal",
      `${stealPercent.toFixed(2)}%`,
      stealPercent > 10 ? "WARN" : "PASS"
    );

    status(
      "I/O wait",
      `${ioPercent.toFixed(2)}%`,
      ioPercent > 15 ? "WARN" : "PASS"
    );
  }

  const load = os.loadavg()[0];
  const cpuCount = cpus.length;

  const loadPerCPU = load / cpuCount;

  status(
    "Load / CPU",
    loadPerCPU.toFixed(2),
    loadPerCPU > 1 ? "WARN" : "PASS"
  );
}

/* ---------------------------------------------------------- */
/* MEMORY */
/* ---------------------------------------------------------- */

function memoryDiagnostics() {
  section("MEMORY");

  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  const usedPercent = (used / total) * 100;

  status("Total memory", bytesToGB(total));
  status("Used memory", bytesToGB(used));
  status("Free memory", bytesToGB(free));

  status(
    "Memory utilization",
    `${usedPercent.toFixed(1)}%`,
    usedPercent > 90 ? "WARN" : "PASS"
  );

  const meminfo = readFile("/proc/meminfo");

  if (meminfo) {
    const swapTotal = meminfo.match(/^SwapTotal:\s+(\d+)/m);
    const swapFree = meminfo.match(/^SwapFree:\s+(\d+)/m);

    if (swapTotal && swapFree) {
      const totalSwap = Number(swapTotal[1]) * 1024;
      const freeSwap = Number(swapFree[1]) * 1024;
      const usedSwap = totalSwap - freeSwap;

      status("Swap", `${bytesToGB(usedSwap)} / ${bytesToGB(totalSwap)}`);

      if (totalSwap > 0) {
        const percent = (usedSwap / totalSwap) * 100;

        status(
          "Swap utilization",
          `${percent.toFixed(1)}%`,
          percent > 50 ? "WARN" : "PASS"
        );
      }
    }
  }
}

/* ---------------------------------------------------------- */
/* NODE.JS */
/* ---------------------------------------------------------- */

function nodeDiagnostics() {
  section("NODE.JS");

  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  status("Node version", process.version);
  status("V8 version", process.versions.v8);
  status("Platform", process.platform);
  status("Architecture", process.arch);

  status("RSS", bytesToMB(memory.rss));
  status("Heap used", bytesToMB(memory.heapUsed));
  status("Heap total", bytesToMB(memory.heapTotal));
  status("External memory", bytesToMB(memory.external));

  const heapPercent =
    (heap.used_heap_size / heap.heap_size_limit) * 100;

  status(
    "Heap limit utilization",
    `${heapPercent.toFixed(1)}%`,
    heapPercent > 80 ? "WARN" : "PASS"
  );

  status(
    "Process uptime",
    `${(process.uptime() / 60).toFixed(1)} minutes`
  );
}

/* ---------------------------------------------------------- */
/* EVENT LOOP */
/* ---------------------------------------------------------- */

async function eventLoopDiagnostics() {
  section("NODE EVENT LOOP");

  const samples = [];

  for (let i = 0; i < 10; i++) {
    const start = performance.now();

    await new Promise(resolve => setImmediate(resolve));

    samples.push(performance.now() - start);
  }

  const max = Math.max(...samples);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

  status(
    "Average event-loop delay",
    `${avg.toFixed(2)} ms`,
    avg > 50 ? "WARN" : "PASS"
  );

  status(
    "Maximum event-loop delay",
    `${max.toFixed(2)} ms`,
    max > 100 ? "WARN" : "PASS"
  );
}

/* ---------------------------------------------------------- */
/* DISK */
/* ---------------------------------------------------------- */

function diskDiagnostics() {
  section("DISK / FILESYSTEM");

  const df = command("df -hP");

  if (!df) {
    status("Filesystem information", "Unavailable", "WARN");
    return;
  }

  console.log(df);

  const lines = df.split("\n").slice(1);

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.trim().split(/\s+/);

    if (parts.length < 6) continue;

    const filesystem = parts[0];
    const usage = parts[4];

    const percent = parseInt(usage, 10);

    if (!Number.isNaN(percent)) {
      status(
        filesystem,
        usage,
        percent >= 90 ? "WARN" : "PASS"
      );
    }
  }

  const inode = command("df -iP");

  if (inode) {
    console.log("\nInode usage:");
    console.log(inode);
  }
}

/* ---------------------------------------------------------- */
/* DISK LATENCY */
/* ---------------------------------------------------------- */

async function diskLatencyDiagnostics() {
  section("DISK LATENCY");

  const testFile = path.join(
    os.tmpdir(),
    `vm-diagnostic-${process.pid}.tmp`
  );

  const data = Buffer.alloc(1024 * 1024, 0x61);

  try {
    const startWrite = performance.now();

    fs.writeFileSync(testFile, data);

    const writeMs = performance.now() - startWrite;

    const startRead = performance.now();

    fs.readFileSync(testFile);

    const readMs = performance.now() - startRead;

    status(
      "1 MB write",
      `${writeMs.toFixed(2)} ms`,
      writeMs > 500 ? "WARN" : "PASS"
    );

    status(
      "1 MB read",
      `${readMs.toFixed(2)} ms`,
      readMs > 500 ? "WARN" : "PASS"
    );

    fs.unlinkSync(testFile);
  } catch (err) {
    status("Disk test", err.message, "WARN");

    try {
      fs.unlinkSync(testFile);
    } catch {}
  }
}

/* ---------------------------------------------------------- */
/* NETWORK */
/* ---------------------------------------------------------- */

async function networkDiagnostics() {
  section("NETWORK");

  const interfaces = os.networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    const ips = addresses
      .map(a => a.address)
      .join(", ");

    status(name, ips);
  }

  const gateway = command("ip route | grep default | head -1");

  if (gateway) {
    status("Default route", gateway);
  } else {
    status("Default route", "Not detected", "WARN");
  }

  const dnsServers = command(
    "awk '/^nameserver/ {print $2}' /etc/resolv.conf"
  );

  if (dnsServers) {
    status("DNS servers", dnsServers.replace(/\n/g, ", "));
  }

  try {
    const start = performance.now();

    await dns.lookup("example.com");

    const elapsed = performance.now() - start;

    status(
      "DNS resolution",
      `${elapsed.toFixed(2)} ms`,
      elapsed > 500 ? "WARN" : "PASS"
    );
  } catch (err) {
    status("DNS resolution", "FAILED", "FAIL");
  }

  await tcpTest("example.com", 443);
}

function tcpTest(host, port) {
  return new Promise(resolve => {
    const start = performance.now();

    const socket = net.createConnection({
      host,
      port,
      timeout: 3000,
    });

    socket.on("connect", () => {
      const elapsed = performance.now() - start;

      status(
        `TCP ${host}:${port}`,
        `${elapsed.toFixed(2)} ms`,
        elapsed > 1000 ? "WARN" : "PASS"
      );

      socket.destroy();
      resolve();
    });

    socket.on("timeout", () => {
      status(`TCP ${host}:${port}`, "TIMEOUT", "FAIL");
      socket.destroy();
      resolve();
    });

    socket.on("error", () => {
      status(`TCP ${host}:${port}`, "FAILED", "FAIL");
      resolve();
    });
  });
}

/* ---------------------------------------------------------- */
/* PROCESSES */
/* ---------------------------------------------------------- */

function processDiagnostics() {
  section("PROCESSES");

  const ps = command(
    "ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm --sort=-%cpu | head -11"
  );

  if (ps) {
    console.log(ps);
  }

  const processCount = command("ps -e --no-headers | wc -l");

  if (processCount) {
    status("Process count", processCount);
  }

  const fdLimit = command("ulimit -n");

  if (fdLimit) {
    status("Open-file limit", fdLimit);
  }
}

/* ---------------------------------------------------------- */
/* RESOURCE LIMITS */
/* ---------------------------------------------------------- */

function limitsDiagnostics() {
  section("RESOURCE LIMITS");

  const limits = command("ulimit -a");

  if (limits) {
    console.log(limits);
  }
}

/* ---------------------------------------------------------- */
/* SECURITY / CONFIGURATION */
/* ---------------------------------------------------------- */

function securityDiagnostics() {
  section("BASIC SECURITY / CONFIGURATION");

  const uid = command("id -u");

  if (uid === "0") {
    status("Running as root", "YES", "WARN");
  } else {
    status("Running as root", "NO", "PASS");
  }

  const ssh = command(
    "systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null"
  );

  if (ssh) {
    status("SSH service", ssh);
  }

  const listening = command(
    "ss -lntup 2>/dev/null | head -30"
  );

  if (listening) {
    console.log("\nListening services:");
    console.log(listening);
  }
}

/* ---------------------------------------------------------- */
/* CLOCK */
/* ---------------------------------------------------------- */

function clockDiagnostics() {
  section("TIME / CLOCK");

  status("System time", new Date().toISOString());

  const sync = command(
    "timedatectl show --property=NTPSynchronized --value 2>/dev/null"
  );

  if (sync) {
    status(
      "NTP synchronized",
      sync,
      sync === "yes" ? "PASS" : "WARN"
    );
  }
}

/* ---------------------------------------------------------- */
/* SUMMARY */
/* ---------------------------------------------------------- */

function summary() {
  section("SUMMARY");

  const pass = results.filter(r => r.state === "PASS").length;
  const warn = results.filter(r => r.state === "WARN").length;
  const fail = results.filter(r => r.state === "FAIL").length;

  console.log(`PASS: ${pass}`);
  console.log(`WARN: ${warn}`);
  console.log(`FAIL: ${fail}`);

  console.log("");

  if (fail > 0) {
    console.log("\x1b[31mOverall status: FAIL\x1b[0m");
  } else if (warn > 0) {
    console.log("\x1b[33mOverall status: WARNING\x1b[0m");
  } else {
    console.log("\x1b[32mOverall status: HEALTHY\x1b[0m");
  }

  console.log("");
}

/* ---------------------------------------------------------- */
/* MAIN */
/* ---------------------------------------------------------- */

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                         VM DIAGNOSTICS                              ║
║                    Node.js System Health Check                      ║
╚══════════════════════════════════════════════════════════════════════╝
`);

  systemDiagnostics();
  virtualizationDiagnostics();
  await cpuDiagnostics();
  memoryDiagnostics();
  nodeDiagnostics();
  await eventLoopDiagnostics();
  diskDiagnostics();
  await diskLatencyDiagnostics();
  await networkDiagnostics();
  processDiagnostics();
  limitsDiagnostics();
  securityDiagnostics();
  clockDiagnostics();

  summary();
}

main().catch(err => {
  console.error("\nDiagnostic error:", err);
  process.exitCode = 1;
});
