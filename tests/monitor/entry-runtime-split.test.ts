import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the monitor entry/runtime split.
 *
 * The plugin monitor runs two ways:
 *   1. `node dist/monitor/index.js` (standalone) — index.ts auto-runs main()
 *      via its `isDirectRun` guard.
 *   2. `npx -y tandem-editor@<v> monitor` — the CLI dynamically imports the
 *      RUNTIME (src/monitor/run.ts) and calls main() itself.
 *
 * The split is load-bearing: in the bundled `dist/cli/index.js`,
 * `process.argv[1] === import.meta.url` resolves TRUE, so if the CLI imported
 * index.ts (with its auto-run) instead of run.ts, main() would fire twice —
 * a doubled SSE subscription that emits every event twice. This test encodes
 * the exact contract so a future refactor can't silently reintroduce the
 * double-run by moving the auto-run into the runtime or repointing the CLI
 * import. A source-reading guard (not a behavioral one) because the bundled
 * double-run reproduces only in the built artifact, not under tsx — see
 * tests/cli/monitor.test.ts for the complementary single-run spawn check.
 */

const REPO_ROOT = resolve(__dirname, "../..");
const runSrc = readFileSync(resolve(REPO_ROOT, "src/monitor/run.ts"), "utf8");
const indexSrc = readFileSync(resolve(REPO_ROOT, "src/monitor/index.ts"), "utf8");
const cliSrc = readFileSync(resolve(REPO_ROOT, "src/cli/index.ts"), "utf8");

describe("monitor entry/runtime split", () => {
  it("run.ts (the shared runtime) carries NO auto-run block", () => {
    // The auto-run must live ONLY in the standalone entry. If run.ts ever
    // grows an `isDirectRun` / `main().catch(...)` self-invocation, the CLI's
    // `await import("../monitor/run.js")` would double-fire main(). Match the
    // CODE constructs, not the bare word — run.ts's header comment discusses
    // isDirectRun by name to explain why it lives elsewhere.
    expect(runSrc).not.toMatch(/const\s+isDirectRun/);
    expect(runSrc).not.toMatch(/if\s*\(\s*isDirectRun/);
    expect(runSrc).not.toMatch(/main\(\)\s*\.catch/);
  });

  it("index.ts (the standalone entry) KEEPS its isDirectRun auto-run", () => {
    // The `node dist/monitor/index.js` path depends on this guard to start.
    expect(indexSrc).toMatch(/const\s+isDirectRun/);
    expect(indexSrc).toMatch(/if\s*\(\s*isDirectRun/);
    expect(indexSrc).toMatch(/main\(\)\s*\.catch/);
    // ...and re-exports the runtime so test importers of index.js keep working.
    expect(indexSrc).toMatch(/export \* from "\.\/run\.js"/);
  });

  it("the CLI monitor subcommand imports the runtime, NOT the auto-run entry", () => {
    // This is the crux: importing "../monitor/index.js" here would pull the
    // auto-run into the CLI bundle and double-fire. Guard both directions.
    expect(cliSrc).toMatch(/await import\("\.\.\/monitor\/run\.js"\)/);
    expect(cliSrc).not.toMatch(/import\("\.\.\/monitor\/index\.js"\)/);
  });
});
