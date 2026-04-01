import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(__dirname, "../server/index.js");

export function runStart(): void {
  if (!existsSync(SERVER_DIST)) {
    console.error(`[Tandem] Server not found at ${SERVER_DIST}`);
    console.error("[Tandem] The installation may be corrupted. Try: npm install -g tandem-editor");
    process.exit(1);
  }

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
  // On Windows SIGTERM is not emitted by the OS, but SIGINT (Ctrl+C) works.
  // Both are listed for Unix compatibility.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => proc.kill());
  }
}
