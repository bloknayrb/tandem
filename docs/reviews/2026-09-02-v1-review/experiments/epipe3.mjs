import { spawn } from "node:child_process";
process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e.code || e.message); process.exit(0); });
const c = spawn("sh", ["-c", "sleep 0.2; exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
setTimeout(() => {
  console.log("writable:", c.stdin.writable);
  // 4MB exceeds pipe buffer; child never reads and exits 100ms later
  c.stdin.write("x".repeat(4*1024*1024) + "\n", (err) => console.log("cb err:", err && err.code));
  setTimeout(() => { console.log("no uncaught after 1s; destroyed:", c.stdin.destroyed); process.exit(0); }, 1000);
}, 100);
