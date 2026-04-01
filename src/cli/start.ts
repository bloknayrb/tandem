import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(__dirname, "../server/index.js");

export function runStart(): void {
  console.error("[Tandem] Starting server...");

  const proc = spawn("node", [SERVER_DIST], {
    stdio: "inherit",
    env: { ...process.env, TANDEM_OPEN_BROWSER: "1" },
  });

  proc.on("error", (err) => {
    console.error(`[Tandem] Failed to start server: ${err.message}`);
    process.exit(1);
  });

  proc.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  // Forward signals — proc.kill() with no argument uses SIGTERM on Unix
  // and TerminateProcess on Windows (correct cross-platform behavior).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      proc.kill();
    });
  }
}
