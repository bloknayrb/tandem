import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The ADR-051 half of #1673's file anchor.
 *
 * Being INSIDE a required job is not what makes a gate safe. `check` already
 * holds two step-level gates pinned from inside itself — `typecheck:tests`
 * (`typecheck-tests-wiring.test.ts`) and the acceptance harness
 * (`acceptance-harness-wiring.test.ts`) — and ADR-051 names the reason: being
 * required makes a RED block, and does nothing about a step that never runs.
 * `run: … || true`, `continue-on-error: true`, `if: success()`, or deleting the
 * step outright each leave `check` green with the anchor dead: the #1229 shape
 * this whole group is about, re-created by the group's own PR.
 *
 * This step is the weakest of the three neighbours precisely because it is the
 * only one carrying an `if:` — an `if:` nothing else constrains.
 *
 * **One owner per fact (ADR-051 rule 5.)** `acceptance-harness-wiring.test.ts`
 * owns the `Test` step's ORDERING against `setup-python`, and locates it with
 * `/^npm test\b/` — a predicate this file must not relax and does not re-assert.
 * This file owns that step's exact COMMAND, and the anchor step.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const TEST_COMMAND =
  "npm test -- --run --reporter=default --reporter=json --outputFile.json=.vitest-report.json";
const ANCHOR_COMMAND = "node scripts/ci/vitest-file-anchor.mjs .vitest-report.json";

type Step = {
  name?: string;
  run?: string;
  if?: string;
  shell?: string;
  "continue-on-error"?: boolean;
};

function checkSteps(): Step[] {
  const workflow = parse(read(".github/workflows/ci.yml")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const job = workflow.jobs.check;
  expect(job, "no `check` job in ci.yml").toBeDefined();
  return job.steps ?? [];
}

function anchorStep(): Step {
  const step = checkSteps().find((s) => s.run?.includes("vitest-file-anchor"));
  expect(step, "the `check` job never runs the vitest file anchor").toBeDefined();
  return step as Step;
}

describe("vitest file anchor — CI wiring", () => {
  it("runs the anchor as a bare command", () => {
    // Exact equality, not `toContain`. It subsumes the whole exit-code-masking
    // family in one assertion — `|| true`, `; true`, `|| echo …`, `set +e &&`,
    // a trailing pipe — which a denylist only ever covers partly. Nothing else
    // in the tree sees a `|| true` here: `check` would stay green with the
    // anchor reporting nothing.
    expect(anchorStep().run?.trim()).toBe(ANCHOR_COMMAND);
  });

  it("keeps the anchor's `if:` at exactly `!cancelled()`", () => {
    // Literal equality, so BOTH wrong answers fail. `success()` is the bug this
    // group is about, written as YAML: a red `Test` would skip the anchor, and
    // a run can both fail a test AND lose files. `always()` would manufacture a
    // cannot-evaluate red on a cancelled run.
    //
    // ADR-051 rule 4: assert presence, never `step.if ?? "…"`, because absent
    // is itself a regression (Actions applies a success()-like default).
    expect(anchorStep().if).toBe("${{ !cancelled() }}");
  });

  it("keeps the anchor blocking, on the runner's default shell", () => {
    const step = anchorStep();
    // Parsed fields, never substrings (ADR-051 rule 2): `continue-on-error` is
    // a sibling of `run:` and never appears inside a shell line.
    expect(step["continue-on-error"], "the anchor step swallows its own failure").toBeFalsy();
    // A non-default shell cascades: a custom shell can drop the failure entirely.
    expect(step.shell).toBeUndefined();
  });

  it("pins the Test step's reporter flags by exact equality", () => {
    // Without this, the reporter flags can be dropped: the anchor then exits 3,
    // which is loud — but the same edit that drops them can delete the anchor
    // step, and then nothing is loud at all. `toContain` on a single flag is
    // defeated by an appended `|| true`.
    //
    // Exact equality also keeps `acceptance-harness-wiring.test.ts`'s
    // `/^npm test\b/` predicate satisfied by construction: that helper THROWS
    // rather than returning -1 when nothing matches, so a `run: |` block whose
    // first line is anything else turns the required `check` job red for a
    // reason unrelated to the diff.
    const step = checkSteps().find((s) => /^npm test\b/.test((s.run ?? "").trim()));
    expect(step, "the `check` job never runs npm test").toBeDefined();
    expect(step?.run?.trim()).toBe(TEST_COMMAND);
  });
});
