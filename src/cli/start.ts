import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MCP_PORT } from "../shared/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(__dirname, "../server/index.js");

export function runStart(): void {
  if (!existsSync(SERVER_DIST)) {
    console.error(`[Tandem] Server not found at ${SERVER_DIST}`);
    console.error("[Tandem] The installation may be corrupted. Try: npm install -g tandem-editor");
    process.exit(1);
  }

  // Lead with the actionable next step (the URL to open) — `tandem` starts the
  // server but opens no window, so a new user needs to be told where the editor
  // lives. The desktop-app recommendation follows as context, not as an alarming
  // "deprecated" banner ahead of any instruction (#new-user-friction audit).
  const editorUrl =
    process.env.TANDEM_URL ?? `http://127.0.0.1:${process.env.TANDEM_MCP_PORT ?? DEFAULT_MCP_PORT}`;
  console.error("[Tandem] Starting server...");
  console.error(`[Tandem] When it's ready, open the editor in your browser at ${editorUrl}`);
  console.error(
    "[Tandem] The desktop app is the primary way to run Tandem — running in a browser " +
      "works but isn't the recommended experience (https://github.com/bloknayrb/tandem/issues/477).",
  );

  const proc = spawn("node", [SERVER_DIST], {
    stdio: "inherit",
    env: process.env,
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
