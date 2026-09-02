// Does writing to a dead child's stdin with a write-callback (and no 'error' listener) raise uncaughtException?
import { spawn } from "node:child_process";
process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e.code || e.message); process.exit(0); });
const c = spawn("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
c.on("exit", () => {
  // child gone; pipe read end closed. Mirror supervisor.sendTurn:
  setTimeout(() => {
    console.log("writable before write:", c.stdin.writable, "destroyed:", c.stdin.destroyed);
    const big = "x".repeat(100) + "\n";
    c.stdin.write(big, (err) => console.log("cb err:", err && err.code));
    setTimeout(() => { console.log("no uncaught after 500ms; writable now:", c.stdin.writable, "destroyed:", c.stdin.destroyed); process.exit(0); }, 500);
  }, 50);
});
