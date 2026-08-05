import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GENERATED_DIR = path.join(__dirname, ".generated");
const APP_DATA_DIR = path.join(GENERATED_DIR, "app-data");

/**
 * Runs once before the perf harness, BEFORE the webServers start.
 *
 * Two jobs, both correctness rather than convenience:
 *
 * 1. Wipe the isolated app-data dir. The fixture is byte-identical run to run
 *    (seeded) while its containing path changes — the two preconditions for
 *    content-hash rename-recovery (#313/#318) to resurrect the last run's
 *    orphaned annotation envelopes into this one. A perf run that started with
 *    50 seeded annotations plus N resurrected ones would measure a margin load
 *    nobody chose, and would drift upward every run.
 *
 * 2. Regenerate the fixture, so the measured document always matches the
 *    checked-in generator rather than whatever an earlier experiment left on
 *    disk.
 */
export default function globalSetup() {
  if (existsSync(APP_DATA_DIR)) {
    rmSync(APP_DATA_DIR, { recursive: true, force: true });
  }

  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "fixtures", "make-perf-doc.mjs")],
    { stdio: "inherit" },
  );
}
