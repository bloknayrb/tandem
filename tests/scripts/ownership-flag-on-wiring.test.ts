import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  OWNERSHIP_DEFINE_KEY,
  planOwnershipBuilds,
  SERVER_OUT_DIR,
} from "../../scripts/ci/build-ownership-on.js";
import {
  EXIT_MISMATCH,
  hashForLog,
  judgeProbe,
  EXIT_CANNOT_EVALUATE as PROBE_CANNOT,
  EXIT_OK as PROBE_OK,
  reservedPorts,
  serverEnvFor,
} from "../../scripts/ci/ownership-bundle-probe.mjs";
import {
  EXIT_CANNOT_EVALUATE,
  EXIT_FAILED,
  EXIT_OK,
  evaluateAnchors,
} from "../../scripts/ci/ownership-flag-on-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The `ownership-flag-on` job and the `check` bundle probe (#2358, ADR-054;
 * ownership design §12). ADR-051: the job does the work; this test, inside
 * `check`, pins the job's shape and the inputs it reads, so disarming it means
 * editing something a required check reads. The job itself is required too
 * while ownership is dark — once an admin adds it to branch protection — so
 * until then this is the only thing that blocks.
 *
 * ADR-051's rules, as applied here:
 * 1. npm scripts the job runs are pinned by exact equality (`test`,
 *    `test:e2e`, `typecheck`).
 * 2. YAML attributes are read as parsed fields: whole step objects are
 *    compared, so a `continue-on-error`, `shell`, `if` or `env` added to any
 *    step changes the object and fails.
 * 3. The SET is pinned: the job's ordered step list is a literal; the job's
 *    own keys are exactly `runs-on` and `steps`.
 * 4. Presence, never with a default: absence of `needs`, `strategy`, `name`,
 *    `if`, `env`, `defaults`, `continue-on-error` is asserted on the parsed
 *    object, not defaulted.
 * 5. One owner per fact: the action SHAs are `workflow-action-pin.test.ts`'s
 *    (compared here to `check`'s, not to a literal); `check`'s Test command
 *    literal is `vitest-file-anchor-wiring.test.ts`'s (the flag-on Test step
 *    must equal it, read from the YAML); "the root `test.env` lacks
 *    TANDEM_OWNERSHIP" is `tests/server/ownership-flag.test.ts`'s.
 */

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps: Step[] };
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/ci.yml");
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf-8")) as Record<string, unknown> & {
  jobs: Record<string, Job>;
};
const job = workflow.jobs["ownership-flag-on"];
const check = workflow.jobs.check;

function checkStep(predicate: (s: Step) => boolean, label: string): Step {
  const step = check.steps.find(predicate);
  if (!step) throw new Error(`ci.yml: check has no ${label} step`);
  return step;
}

const usesOf = (prefix: string) =>
  checkStep((s) => typeof s.uses === "string" && s.uses.startsWith(prefix), prefix).uses;
/** `check`'s own step, whole: the owner of its shape is whichever test pins it there. */
const sameAsCheck = (predicate: (s: Step) => boolean, label: string) => checkStep(predicate, label);
const usesStep = (prefix: string) =>
  sameAsCheck((s) => typeof s.uses === "string" && s.uses.startsWith(prefix), prefix);
const checkTestRun = checkStep((s) => s.name === "Test", "Test").run;

const PROBE_ON = "node scripts/ci/ownership-bundle-probe.mjs --expect on";
const PROBE_OFF = "node scripts/ci/ownership-bundle-probe.mjs --expect off";

describe("the ownership-flag-on job (ADR-051)", () => {
  it("exists, under exactly that key, with nothing that can skip, rename or soften it", () => {
    expect(job, "ci.yml has no `ownership-flag-on` job").toBeDefined();
    // A skipped job (`if`, or a failed `needs`) reports SUCCESS to branch
    // protection; a job `name` or a matrix renames the check so the required
    // context never reports; job `env`/`defaults`/`container` change what every
    // step runs under.
    expect(Object.keys(job).sort()).toEqual(["runs-on", "steps"]);
    expect(job["runs-on"]).toBe("ubuntu-latest");
  });

  it("the workflow sets no env or defaults that every job would inherit", () => {
    expect(workflow.env).toBeUndefined();
    expect(workflow.defaults).toBeUndefined();
  });

  it("runs exactly these steps, in this order, each exactly as written", () => {
    expect(typeof checkTestRun).toBe("string");
    // The steps it shares with `check` are compared to check's own, whole:
    // their shape is owned where check's is pinned (ADR-051 rule 5).
    expect(job.steps).toEqual([
      usesStep("actions/checkout@"),
      usesStep("actions/setup-node@"),
      usesStep("actions/setup-python@"),
      sameAsCheck((s) => s.run === "npm ci --ignore-scripts", "npm ci"),
      { name: "Typecheck", run: "npm run typecheck" },
      {
        name: "Build (ownership on)",
        run: "node node_modules/tsx/dist/cli.mjs scripts/ci/build-ownership-on.ts",
      },
      { name: "Built bundle is ownership-on", run: PROBE_ON, "timeout-minutes": 2 },
      // The same command `check` runs — so the flag-on run is the same suite
      // with the same reporters — plus the variable, on this step only.
      { name: "Test", run: checkTestRun, env: { TANDEM_OWNERSHIP: "1" } },
      {
        name: "Ownership anchor ran flag-on",
        if: "${{ !cancelled() }}",
        run: "node scripts/ci/ownership-flag-on-runner.mjs .vitest-report.json",
      },
      {
        name: "Every collected test file actually ran",
        if: "${{ !cancelled() }}",
        run: "node scripts/ci/vitest-file-anchor.mjs .vitest-report.json",
      },
      sameAsCheck((s) => s.name === "Drop the unused Google Chrome apt source", "apt drop"),
      sameAsCheck((s) => s.name === "Install Playwright browsers", "Playwright install"),
      { name: "E2E tests", run: "npm run test:e2e", env: { TANDEM_OWNERSHIP: "1" } },
      {
        name: "Upload Playwright report",
        uses: usesOf("actions/upload-artifact@"),
        if: "failure()",
        with: {
          name: "playwright-report-ownership-flag-on",
          path: "playwright-report/\ntest-results/\n",
        },
      },
    ]);
  });

  it("the npm scripts it runs cannot swallow a failure", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("vitest");
    expect(pkg.scripts["test:e2e"]).toBe("playwright test");
    expect(pkg.scripts.typecheck).toBe(
      "tsc -p tsconfig.server.json --noEmit && tsc --noEmit && svelte-check --tsconfig ./tsconfig.client.json --fail-on-warnings",
    );
  });

  it("E2E under CI runs the built bundle the probe checked", () => {
    // The flag-on E2E step carries TANDEM_OWNERSHIP=1, so it is flag-on on
    // either branch; this pins that the CI branch is the bundle, which the
    // probe proved ownership-on by its define.
    const src = readFileSync(path.join(ROOT, "playwright.config.ts"), "utf-8");
    expect(src).toMatch(
      /command:\s*process\.env\.CI\s*\?\s*"node scripts\/e2e-server\.mjs dist\/server\/index\.js"/,
    );
  });
});

describe("check never runs flag-on, and proves the release bundle ignores the variable", () => {
  it("TANDEM_OWNERSHIP appears in no check-job env and on no other check step", () => {
    expect(check.env).toBeUndefined();
    for (const step of check.steps) {
      const env = step.env as Record<string, unknown> | undefined;
      expect(env?.TANDEM_OWNERSHIP, `check step ${String(step.name ?? step.run)}`).toBeUndefined();
    }
  });

  it("the probe step is pinned whole, immediately after Build", () => {
    const i = check.steps.findIndex((s) => s.run === PROBE_OFF);
    expect(i, "check no longer runs the --expect off probe").toBeGreaterThan(0);
    expect(check.steps[i - 1]).toEqual({ name: "Build", run: "npm run build" });
    expect(check.steps[i]).toEqual({
      name: "Release bundle ignores TANDEM_OWNERSHIP",
      run: PROBE_OFF,
      "timeout-minutes": 2,
    });
  });
});

describe("scripts/ci/build-ownership-on.ts plans the flag-on build", () => {
  const TSUP_CONFIG_URL = pathToFileURL(path.join(ROOT, "tsup.config.ts")).href;

  it("flips the define on the server block of the real config and builds every block", async () => {
    const config: unknown = (await import(TSUP_CONFIG_URL)).default;
    expect(Array.isArray(config)).toBe(true);
    const plan = planOwnershipBuilds(config);
    expect(plan).toHaveLength((config as unknown[]).length);
    for (const p of plan) expect(p.options.config).toBe(false);
    const server = plan.find((p) => p.options.outDir === SERVER_OUT_DIR);
    expect(server?.flipped).toBe(true);
    expect(server?.options.define?.[OWNERSHIP_DEFINE_KEY]).toBe("true");
    // Everything else the block carries survives the override.
    expect(server?.options.define?.__DOCX_ENABLED__).toBe("false");
    expect(server?.options.entry).toEqual(["src/server/index.ts"]);
  });

  it("refuses a config it cannot plan, rather than building a flag-off bundle", () => {
    expect(() => planOwnershipBuilds({ outDir: SERVER_OUT_DIR })).toThrow(/array/);
    expect(() => planOwnershipBuilds([{ outDir: "dist/cli" }])).toThrow(/dist\/server/);
    expect(() =>
      planOwnershipBuilds([{ outDir: SERVER_OUT_DIR, define: { __RENAMED__: "false" } }]),
    ).toThrow(/carries no __OWNERSHIP_ENABLED__/);
  });

  it("leaves a block without the define unchanged", () => {
    const block = { outDir: "dist/channel", entry: ["src/channel/index.ts"] };
    const plan = planOwnershipBuilds([
      { outDir: SERVER_OUT_DIR, define: { [OWNERSHIP_DEFINE_KEY]: "false", __X__: "1" } },
      block,
    ]);
    expect(plan[1]).toEqual({ options: { ...block, config: false }, flipped: false });
    expect(plan[0].options.define).toEqual({ [OWNERSHIP_DEFINE_KEY]: "true", __X__: "1" });
  });
});

describe("scripts/ci/ownership-flag-on-runner.mjs", () => {
  const FIXTURES = path.join(ROOT, "tests/scripts/fixtures/ownership-anchor");
  // Captured from real vitest JSON reports of tests/server/ownership-anchor.test.ts
  // (vitest 5.0.5), run once with TANDEM_OWNERSHIP=1 and once without, then
  // trimmed and given repo-relative names.
  const passed = JSON.parse(readFileSync(path.join(FIXTURES, "passed.json"), "utf-8"));
  const skipped = JSON.parse(readFileSync(path.join(FIXTURES, "skipped.json"), "utf-8"));
  const runner = path.join(ROOT, "scripts/ci/ownership-flag-on-runner.mjs");

  it("passes a run where every anchor assertion passed", () => {
    expect(evaluateAnchors(passed, ROOT).code).toBe(EXIT_OK);
  });

  it("refuses a run where the anchor skipped: the variable never reached the workers", () => {
    // vitest reports this file's status as `passed`; only assertions tell.
    expect(skipped.testResults[0].status).toBe("passed");
    const v = evaluateAnchors(skipped, ROOT);
    expect(v.code).toBe(EXIT_FAILED);
    expect(v.reason).toMatch(/flag-off/);
  });

  it("refuses a failed anchor and a failed run", () => {
    const failed = structuredClone(passed);
    failed.testResults[0].assertionResults[0].status = "failed";
    expect(evaluateAnchors(failed, ROOT).code).toBe(EXIT_FAILED);
    const runFailed = structuredClone(passed);
    runFailed.success = false;
    runFailed.numFailedTests = 1;
    expect(evaluateAnchors(runFailed, ROOT).code).toBe(EXIT_FAILED);
  });

  it("cannot evaluate a report without the anchor file, or no report at all", () => {
    const missing = structuredClone(passed);
    missing.testResults[0].name = "tests/server/something-else.test.ts";
    expect(evaluateAnchors(missing, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
    expect(evaluateAnchors(null, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
    expect(evaluateAnchors({ success: true }, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
  });

  it("its main maps each verdict to its exit code (spawned)", () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [runner, ...args], { cwd: ROOT, encoding: "utf-8" }).status;
    expect(run([path.join(FIXTURES, "passed.json")])).toBe(0);
    expect(run([path.join(FIXTURES, "skipped.json")])).toBe(1);
    expect(run([path.join(FIXTURES, "no-such-report.json")])).toBe(3);
    expect(run([])).toBe(3);
  });
});

describe("scripts/ci/ownership-bundle-probe.mjs", () => {
  const MCP = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const CLAUDE = "6f1c3a52-9b7d-4e0f-8a2c-1d5e7b9f3c40";
  const line = (a: string, b: string) =>
    `[Tandem] MCP session established: ${a} (claude session ${b}) (client x) — 1 live`;
  const probe = path.join(ROOT, "scripts/ci/ownership-bundle-probe.mjs");

  it("judges ON only when both of its ids are hashed and neither is raw", () => {
    const on = line(hashForLog(MCP), hashForLog(CLAUDE));
    expect(judgeProbe(on, [MCP, CLAUDE], "on").code).toBe(PROBE_OK);
    expect(judgeProbe(line(MCP, CLAUDE), [MCP, CLAUDE], "on").code).toBe(EXIT_MISMATCH);
    expect(judgeProbe(line(hashForLog(MCP), CLAUDE), [MCP, CLAUDE], "on").code).toBe(EXIT_MISMATCH);
  });

  it("judges OFF only when both of its ids are raw and neither is hashed", () => {
    expect(judgeProbe(line(MCP, CLAUDE), [MCP, CLAUDE], "off").code).toBe(PROBE_OK);
    expect(judgeProbe(line(hashForLog(MCP), hashForLog(CLAUDE)), [MCP, CLAUDE], "off").code).toBe(
      EXIT_MISMATCH,
    );
  });

  it("cannot evaluate a log with no session line, or no ids", () => {
    expect(judgeProbe("[Tandem] Starting server", [MCP, CLAUDE], "on").code).toBe(PROBE_CANNOT);
    expect(judgeProbe(line(MCP, CLAUDE), [], "off").code).toBe(PROBE_CANNOT);
  });

  it("hashes exactly as src/server/sessions/log-id.ts does", () => {
    const src = readFileSync(path.join(ROOT, "src/server/sessions/log-id.ts"), "utf-8");
    expect(src).toContain('createHash("sha256").update(id).digest("hex").slice(0, 8)');
    expect(hashForLog(MCP)).toMatch(/^#[0-9a-f]{8}$/);
  });

  it("builds the child's environment itself: isolated homes, no inherited secrets, the variable only for --expect off", () => {
    const parent = {
      PATH: "/bin",
      TANDEM_AUTH_TOKEN: "secret",
      HOME: "/real",
      TANDEM_OWNERSHIP: "1",
    };
    const on = serverEnvFor("on", "/tmp/p", { ws: 5001, mcp: 5002 }, parent);
    expect(on.TANDEM_OWNERSHIP).toBeUndefined();
    expect(on.TANDEM_AUTH_TOKEN).toBeUndefined();
    expect(on.PATH).toBe("/bin");
    for (const k of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      // XDG_DATA_HOME matters most: the auth token file lives under env-paths'
      // data dir and ignores TANDEM_APP_DATA_DIR.
      expect(on[k]?.startsWith(path.join("/tmp/p", "home")), k).toBe(true);
    }
    expect(on.TANDEM_APP_DATA_DIR).toBe(path.join("/tmp/p", "app-data"));
    expect(on).toMatchObject({
      TANDEM_PORT: "5001",
      TANDEM_MCP_PORT: "5002",
      TANDEM_NO_SAMPLE: "1",
      TANDEM_DISABLE_LAUNCHER: "1",
      TANDEM_DISABLE_FIRST_RUN_WIZARD: "1",
    });
    const off = serverEnvFor("off", "/tmp/p", { ws: 5001, mcp: 5002 }, parent);
    expect(off.TANDEM_OWNERSHIP).toBe("1");
  });

  it("never picks the product's ports or a reserved test pair", () => {
    const avoid = reservedPorts(readFileSync(path.join(ROOT, "scripts/test-ports.ts"), "utf-8"));
    for (const p of [3478, 3479, 4573, 4728, 4729, 4378, 4379])
      expect(avoid.has(p), String(p)).toBe(true);
  });

  it("boots its entry with an environment it built itself (spawned against fixture servers)", () => {
    // The env-following fixture hashes exactly when TANDEM_OWNERSHIP=1 reaches
    // it, as a bundle with the define dropped would, and refuses to start
    // unless the probe isolated its home. So both expectations must FAIL
    // against it: `off` because the probe hands the child the variable, `on`
    // because it hands it nothing. A probe that inherited the parent's env, or
    // stopped setting the variable for `off`, turns one of these green.
    const fixtures = path.join(ROOT, "tests/scripts/fixtures/ownership-probe");
    const boot = (expect: string, entry: string) =>
      spawnSync(process.execPath, [probe, `--expect=${expect}`, `--entry=${entry}`], {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, TANDEM_OWNERSHIP: "1", TANDEM_AUTH_TOKEN: "x".repeat(40) },
        timeout: 60_000,
      });
    const follower = path.join(fixtures, "env-following-server.mjs");
    const off = boot("off", follower);
    expect(off.status, off.stderr).toBe(1);
    expect(off.stderr).toMatch(/expected ownership OFF: 0\/2 id\(s\) printed raw, 2 hashed/);
    const on = boot("on", follower);
    expect(on.status, on.stderr).toBe(1);
    expect(on.stderr).toMatch(/expected ownership ON: 2 id\(s\) printed raw, 0\/2 hashed/);
    const silent = boot("off", path.join(fixtures, "silent-server.mjs"));
    expect(silent.status, silent.stderr).toBe(3);
    expect(silent.stderr).toMatch(/no 'MCP session established' line/);
    const exiting = boot("off", path.join(fixtures, "exiting-server.mjs"));
    expect(exiting.status, exiting.stderr).toBe(3);
    expect(exiting.stderr).toMatch(/never became healthy/);
  }, 120_000);

  it("its main maps each verdict to its exit code (spawned, judging a captured log)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ownership-probe-test-"));
    try {
      const file = path.join(dir, "stderr.txt");
      const run = (expect: string, text: string, ids = `${MCP},${CLAUDE}`) => {
        writeFileSync(file, text);
        return spawnSync(
          process.execPath,
          [probe, `--expect=${expect}`, `--stderr-file=${file}`, `--ids=${ids}`],
          { cwd: ROOT, encoding: "utf-8" },
        ).status;
      };
      expect(run("on", line(hashForLog(MCP), hashForLog(CLAUDE)))).toBe(0);
      expect(run("on", line(MCP, CLAUDE))).toBe(1);
      expect(run("off", line(MCP, CLAUDE))).toBe(0);
      expect(run("off", "nothing")).toBe(3);
      // An empty id is "printed raw" by every string; it must not judge.
      expect(run("off", line(MCP, CLAUDE), `${MCP},`)).toBe(3);
      expect(run("sideways", line(MCP, CLAUDE))).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
