#!/usr/bin/env node
/**
 * #1529 — run the real-`icacls` proofs on a Windows host, and refuse to report
 * success where they could not have executed.
 *
 * The problem this exists for: `tests/server/file-io/doc-backup-acl-repair.test.ts`
 * and the Windows half of `tests/server/integrations/acl-win.test.ts` are the only
 * tests that spawn real `icacls`, and CI's only vitest runner (the `check` job) is
 * `ubuntu-latest`. On Linux they skip, vitest exits 0, and — measured — the JSON
 * reporter scores `doc-backup-acl-repair.test.ts` as file status `passed` with a
 * single `skipped` assertion. The suite's signal was indistinguishable from the
 * proof passing.
 *
 * So `vitest run <those files>` is NOT a gate on its own: it is green on every
 * host where the thing under test cannot run. This script is the gate. Every
 * check below exists because its absence produces a green run that proved nothing:
 *
 *   - platform refusal    → an OS-matrix edit (`runs-on: ubuntu-latest`) would
 *                           otherwise skip everything and exit 0.
 *   - `icacls.exe` probe  → a runner image without it fails HERE, by name, rather
 *                           than as an opaque spawn error inside a test.
 *   - per-suite accounting → the decisive one. A whole-file `passed >= 1` check is
 *                           defeated by `acl-win.test.ts`, whose `source contract`
 *                           and `POSIX no-op` describes yield 3 passes on Linux
 *                           with the Windows describe entirely skipped. Each spec
 *                           therefore names the Windows-gated `describe` that MUST
 *                           have run, and that suite must show >=1 passed, 0
 *                           skipped, 0 failed.
 *   - fresh report dir    → a leftover JSON report at a fixed path would be parsed
 *                           as this run's if vitest died before writing one.
 *
 * Deliberately node + vitest only. It does not lint, format or typecheck: the
 * working tree on a Windows checkout is the one place CLAUDE.md's
 * `core.autocrlf` × `.gitattributes eol=lf` hazard bites, and this gate must not
 * be able to go red for a line-ending reason that has nothing to do with ACLs.
 *
 * Wired by the `windows-acl-proof` job in `.github/workflows/ci.yml` and pinned by
 * `tests/scripts/windows-acl-proof-wiring.test.ts`, which also runs THIS FILE on
 * the ubuntu leg to prove the platform refusal is real.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The real-`icacls` specs, each paired with the Windows-gated `describe` title
 * that must have executed.
 *
 * The suite title is the load-bearing half. Pinning a file alone cannot tell a
 * run where the Windows describe was disabled from one where it passed — see the
 * `acl-win.test.ts` case in the header. A rename of either describe fails this
 * gate loudly, which is the intended cost: re-pointing the constant is then a
 * deliberate edit rather than silent drift.
 *
 * `tests/scripts/windows-acl-proof-wiring.test.ts` scans all of `tests/` for test
 * files that spawn real `icacls` and fails if one is missing from this list.
 */
export const WINDOWS_ACL_PROOF_SPECS = [
  {
    spec: "tests/server/file-io/doc-backup-acl-repair.test.ts",
    suite: "doc-backup — recovery from a pre-#1299 poisoned install",
  },
  {
    spec: "tests/server/integrations/acl-win.test.ts",
    suite: "acl-win — Windows DACL hardening",
  },
];

/** Normalize for comparison: the JSON reporter emits native separators. */
const toPosix = (p) => String(p).replace(/\\/g, "/");

/**
 * Pure. Given vitest's JSON report and the declared specs, decide whether the
 * proof actually ran. Split out from the CLI so it can be exercised against
 * synthetic reports — including the all-skipped one this whole file exists to
 * reject — without needing a Windows host.
 *
 * @returns {{ok: boolean, failures: string[], lines: string[]}}
 */
export function evaluateReport({ report, specs }) {
  const failures = [];
  const lines = [];

  if (!report || !Array.isArray(report.testResults)) {
    // Never "nothing to check, therefore fine".
    return { ok: false, failures: ["vitest produced no parseable JSON report"], lines };
  }

  for (const { spec, suite } of specs) {
    const wanted = toPosix(spec);
    const entries = report.testResults.filter((r) => toPosix(r.name).endsWith(wanted));
    if (entries.length !== 1) {
      failures.push(`${spec}: expected exactly 1 report entry, got ${entries.length}`);
      continue;
    }

    const assertions = entries[0].assertionResults ?? [];
    const inSuite = assertions.filter((a) => (a.ancestorTitles ?? []).includes(suite));
    if (inSuite.length === 0) {
      failures.push(
        `${spec}: the Windows-gated suite ${JSON.stringify(suite)} produced no results — ` +
          `renamed, removed, or never collected`,
      );
      continue;
    }

    const count = (status) => inSuite.filter((a) => a.status === status).length;
    const passed = count("passed");
    // vitest's JSON reporter emits "skipped"; jest-compatible consumers also see
    // "pending". Count both so a reporter change cannot launder a skip into a
    // status this gate does not recognise.
    const skipped = count("skipped") + count("pending");
    const failed = count("failed");
    lines.push(`${spec} :: ${suite} — passed=${passed} skipped=${skipped} failed=${failed}`);

    if (passed < 1) {
      failures.push(`${spec}: ${suite} executed no passing test body (skipped=${skipped})`);
    }
    if (skipped > 0) {
      failures.push(
        `${spec}: ${suite} skipped ${skipped} test(s) — on a Windows host it must run in full`,
      );
    }
    if (failed > 0) {
      failures.push(`${spec}: ${suite} had ${failed} failing test(s)`);
    }
  }

  if (report.success !== true) {
    failures.push("vitest reported success=false for the run");
  }

  return { ok: failures.length === 0, failures, lines };
}

function fail(message) {
  console.error(`windows-acl-proof: ${message}`);
  process.exit(1);
}

function main() {
  // 1. The refusal that makes an OS-matrix edit fail red instead of green.
  if (process.platform !== "win32") {
    fail(
      `refusing to report success on platform "${process.platform}". These specs are ` +
        `Windows-gated: on any other host they all skip and vitest exits 0, which is the ` +
        `exact vacuity this gate exists to prevent (#1529). Run it on windows-latest.`,
    );
  }

  // 2. The tool the proof is a proof ABOUT.
  const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  if (!existsSync(icacls)) {
    fail(`icacls.exe not found at ${icacls}; the real-icacls proof cannot be evaluated here`);
  }

  // 3. Named specs must exist. `vitest run` already exits 1 on "No test files
  //    found", but that message does not say WHICH declared spec vanished.
  for (const { spec } of WINDOWS_ACL_PROOF_SPECS) {
    if (!existsSync(path.join(ROOT, spec))) {
      fail(`declared spec ${spec} does not exist`);
    }
  }

  const vitestEntry = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitestEntry)) {
    fail(`vitest entry not found at ${vitestEntry}; run \`npm ci\` first`);
  }

  // 4. Fresh directory per run: a leftover report at a fixed path would be read
  //    as this run's result if vitest died before writing one.
  const reportDir = mkdtempSync(path.join(tmpdir(), "windows-acl-proof-"));
  const reportPath = path.join(reportDir, "report.json");

  try {
    const proc = spawnSync(
      process.execPath,
      [
        vitestEntry,
        "run",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
        ...WINDOWS_ACL_PROOF_SPECS.map(({ spec }) => spec),
      ],
      { cwd: ROOT, stdio: "inherit" },
    );

    if (!existsSync(reportPath)) {
      fail(`vitest wrote no JSON report to ${reportPath} (exit ${proc.status})`);
    }

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf-8"));
    } catch (err) {
      fail(`vitest's JSON report is unparseable: ${err.message}`);
    }

    const { ok, failures, lines } = evaluateReport({
      report,
      specs: WINDOWS_ACL_PROOF_SPECS,
    });
    for (const line of lines) console.log(`windows-acl-proof: ${line}`);

    // Checked separately from the report: a report that looks healthy while
    // vitest exited non-zero (an unhandled rejection, a worker crash) must not
    // pass.
    if (proc.status !== 0) {
      fail(`vitest exited ${proc.status}`);
    }
    if (!ok) {
      for (const failure of failures) console.error(`windows-acl-proof: ${failure}`);
      fail("the real-icacls proof did not execute as required");
    }

    console.log("windows-acl-proof: OK — every Windows-gated icacls suite ran in full");
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

// Only run when invoked as a script, so the wiring test can import the exports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
