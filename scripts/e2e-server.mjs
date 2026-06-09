// Playwright webServer launcher for the E2E backend.
//
// Exists so the isolated app-data dir (TANDEM_APP_DATA_DIR) is wiped exactly
// once per server START, not at config evaluation: Playwright re-imports
// playwright.config.ts in every worker process (and on --list / UI-mode
// refreshes), so a config-level rmSync would re-fire mid-run underneath the
// live server.
//
// Why the dir must be RESET per run, not just isolated: durable annotation
// envelopes accumulate there across runs (closing a doc never deletes its
// envelope), and the content-hash rename recovery (#313/#318) resurrects any
// leftover whose content matches a new fixture — every `sample.md` fixture
// has identical content, so a single envelope left by a past failed run
// cascades "expected 1 annotation card, received N" failures through the
// whole suite, self-feeding on each retry.
//
// Usage: node scripts/e2e-server.mjs <server-entry> [args...]
// The remaining argv is run under this same Node binary.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const dir = process.env.TANDEM_APP_DATA_DIR;
if (!dir || !dir.includes("tandem-e2e")) {
  // Refuse to recursively delete anything that isn't an obviously E2E-scoped
  // path — this script only ever runs via playwright.config.ts, which sets it.
  console.error(
    `[e2e-server] refusing to wipe unexpected TANDEM_APP_DATA_DIR: ${dir ?? "(unset)"}`,
  );
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
