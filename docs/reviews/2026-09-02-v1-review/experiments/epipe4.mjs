// Does a ChildProcess-level 'error' listener (which supervisor.ts has) swallow a stdin EPIPE? 
import { spawn } from "node:child_process";
process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e.code || e.message); process.exit(0); });
const c = spawn("sh", ["-c", "exec 0<&-; sleep 2"], { stdio: ["pipe", "pipe", "pipe"] });
c.on("error", (e) => console.log("child error listener got:", e.code));
c.on("exit", () => console.log("exit"));
setTimeout(() => {
  c.stdin.write("x".repeat(100) + "\n", (err) => console.log("cb err:", err && err.code));
  setTimeout(() => { console.log("no uncaught after 500ms"); process.exit(0); }, 500);
}, 300);
