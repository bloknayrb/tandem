// Child ALIVE but has closed its stdin read end. Mirrors a reaper/claude that stopped reading.
import { spawn } from "node:child_process";
process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e.code || e.message); process.exit(0); });
const c = spawn("sh", ["-c", "exec 0<&-; sleep 2"], { stdio: ["pipe", "pipe", "pipe"] });
setTimeout(() => {
  console.log("writable before write:", c.stdin.writable, "destroyed:", c.stdin.destroyed);
  c.stdin.write("x".repeat(100) + "\n", (err) => console.log("cb err:", err && err.code));
  setTimeout(() => { console.log("no uncaught after 500ms; writable now:", c.stdin.writable, "destroyed:", c.stdin.destroyed); process.exit(0); }, 500);
}, 300);
