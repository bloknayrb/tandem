import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  EXIT_CANNOT_EVALUATE,
  EXIT_FAILED,
  EXIT_OK,
  evaluateGatedSpecs,
  GATED_SPECS_FILE,
} from "../../scripts/ci/byo-flag-on-anchor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The `byo-flag-on` job (#1123 PR 8a; ADR-039's amendment on E2E for the
 * Models specs, Ruling R-e1): the whole Playwright suite with
 * `BYO_MODELS_ENABLED` edited to `true` in the job's own checkout.
 *
 * The job is ADVISORY and TEMPORARY. It is not a required status check, so a
 * red run blocks nothing; the flip PR deletes it, this file, the anchor and
 * its fixtures, because `check` then runs the local-model specs lit. ADR-051:
 * the job does the work, and this test, inside `check`, pins its shape, so
 * disarming it means editing something a required check reads.
 *
 * What this pins: the job exists under this id with exactly these keys; its
 * steps, as whole objects, in order (so an added `if`, `continue-on-error`,
 * `|| true`, a removed sed, a build moved before the sed, or a removed anchor
 * fails); the steps it shares with `check` compared to `check`'s parsed ones
 * (ADR-051 rule 5); the two package scripts it runs; and the anchor's verdicts
 * on fixtures.
 *
 * ADR-051 rule 5, one owner per fact. Not re-asserted here: the action SHAs
 * (`workflow-action-pin.test.ts`), the `npm ci --ignore-scripts` spelling and
 * site count (`release-ci-hygiene.test.ts`), the workflow's triggers and
 * token (`vitest-windows-wiring.test.ts`).
 */

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps: Step[] };

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  jobs: Record<string, Job>;
};
const JOB_ID = "byo-flag-on";

function byoJob(): Job {
  const job = workflow.jobs[JOB_ID];
  if (!job) {
    throw new Error(
      `.github/workflows/ci.yml has no \`${JOB_ID}\` job. Nothing runs the local-model E2E ` +
        "specs lit before the flip — see tests/scripts/byo-flag-on-wiring.test.ts.",
    );
  }
  return job;
}

function checkStep(predicate: (s: Step) => boolean, label: string): Step {
  const step = workflow.jobs.check.steps.find(predicate);
  if (!step) throw new Error(`ci.yml: check has no ${label} step`);
  return step;
}

const usesStep = (prefix: string) =>
  checkStep((s) => typeof s.uses === "string" && s.uses.startsWith(prefix), prefix);
const namedStep = (name: string) => checkStep((s) => s.name === name, name);

describe("the byo-flag-on job (#1123 PR 8a, ADR-051)", () => {
  it("exists under that id, on ubuntu, with nothing that can skip or soften it", () => {
    const job = byoJob();
    // The key set, not a list of forbidden keys: `if` and a failed `needs` skip
    // the job, `continue-on-error` turns its red green, job `env`/`defaults`
    // change what every step runs under.
    expect(Object.keys(job).sort()).toEqual(["runs-on", "steps", "timeout-minutes"]);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(45);
  });

  it("runs exactly these steps, in this order", () => {
    expect(byoJob().steps).toEqual([
      usesStep("actions/checkout@"),
      usesStep("actions/setup-node@"),
      checkStep((s) => s.run === "npm ci --ignore-scripts", "npm ci"),
      {
        name: "Local models on (this workspace only)",
        run:
          "sed -i 's/^export const BYO_MODELS_ENABLED = false;$/export const BYO_MODELS_ENABLED = true;/' src/shared/constants.ts" +
          " && test \"$(grep -c '^export const BYO_MODELS_ENABLED = true;$' src/shared/constants.ts)\" = 1",
      },
      // After the sed: the backend under CI is the BUILT server.
      { name: "Build (server)", run: "npm run build:server" },
      namedStep("Drop the unused Google Chrome apt source"),
      namedStep("Install Playwright browsers"),
      {
        name: "E2E tests (local models on)",
        run: "npm run test:e2e -- --reporter=list,json",
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: ".e2e-byo.json" },
      },
      {
        name: "Gated specs ran",
        if: "${{ !cancelled() }}",
        run: "node scripts/ci/byo-flag-on-anchor.mjs .e2e-byo.json",
      },
      {
        name: "Upload E2E report",
        uses: (byoJob().steps.at(-1) as Step).uses,
        if: "failure()",
        with: { name: "e2e-byo-flag-on", path: ".e2e-byo.json\ntest-results/\n" },
      },
    ]);
    expect(String((byoJob().steps.at(-1) as Step).uses)).toMatch(/^actions\/upload-artifact@/);
  });

  it("the sed matches the literal on this checkout, exactly once", () => {
    // A renamed or reformatted literal would leave the sed matching nothing;
    // the job's own grep then fails, but this says so in `check` first.
    const src = readFileSync(path.join(ROOT, "src/shared/constants.ts"), "utf-8");
    expect(src.match(/^export const BYO_MODELS_ENABLED = (?:false|true);$/gm)).toHaveLength(1);
  });

  it("the package scripts it runs are tsup and playwright alone", () => {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")).scripts;
    expect(scripts["build:server"]).toBe("tsup");
    expect(scripts["test:e2e"]).toBe("playwright test");
  });
});

describe("scripts/ci/byo-flag-on-anchor.mjs", () => {
  const FIXTURES = path.join(ROOT, "tests/scripts/fixtures/byo-flag-on-anchor");
  // Built from a real Playwright JSON report (1.64) of chat-answerer.spec.ts,
  // run dark (skipped), then trimmed; the passing and nested ones edit only
  // the statuses and add a nested describe.
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8"));
  const list = fixture("list.json");
  const anchor = path.join(ROOT, "scripts/ci/byo-flag-on-anchor.mjs");

  it("passes a run where every gated spec ran with nothing skipped, nested describes included", () => {
    expect(evaluateGatedSpecs(fixture("passed.json"), list).code).toBe(EXIT_OK);
  });

  it("refuses a dark run: the gated spec is in the report, skipped", () => {
    const v = evaluateGatedSpecs(fixture("skipped.json"), list);
    expect(v.code).toBe(EXIT_FAILED);
    expect(v.reason).toContain("skipped");
  });

  it("refuses a skip inside a nested describe", () => {
    expect(evaluateGatedSpecs(fixture("nested-skipped.json"), list).code).toBe(EXIT_FAILED);
  });

  it("refuses a gated spec absent from the report", () => {
    const v = evaluateGatedSpecs(fixture("missing-spec.json"), list);
    expect(v.code).toBe(EXIT_FAILED);
    expect(v.reason).toContain("not in the report");
  });

  it("cannot evaluate an empty list or a report with no suites", () => {
    expect(evaluateGatedSpecs(fixture("passed.json"), fixture("empty-list.json")).code).toBe(
      EXIT_CANNOT_EVALUATE,
    );
    expect(evaluateGatedSpecs({}, list).code).toBe(EXIT_CANNOT_EVALUATE);
  });

  it.each([
    ["passed.json", EXIT_OK],
    ["skipped.json", EXIT_FAILED],
    ["malformed.json", EXIT_CANNOT_EVALUATE],
    ["does-not-exist.json", EXIT_CANNOT_EVALUATE],
  ])("as a process, %s exits %i", (report, code) => {
    const r = spawnSync(
      process.execPath,
      [anchor, path.join(FIXTURES, report), path.join(FIXTURES, "list.json")],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(code);
  });

  it("as a process with no list argument, reads the real gated list (an empty one cannot pass)", () => {
    const r = spawnSync(process.execPath, [anchor, path.join(FIXTURES, "passed.json")], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    // passed.json holds only chat-answerer, so the real list's other specs are missing.
    expect(r.status).toBe(EXIT_FAILED);
    const real = JSON.parse(readFileSync(path.join(ROOT, GATED_SPECS_FILE), "utf-8"));
    expect(real.length).toBeGreaterThan(0);
  });
});
