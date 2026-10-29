import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #1988 — on Linux the desktop shell starts its Node sidecar through
 * `tandem-reaper --exec-with-pdeathsig`, so the sidecar dies with the shell.
 * The only proof that mode works is `reaper/tests/exec_pdeathsig.rs` — most
 * importantly, that the parent-death signal follows the FORKING THREAD, which
 * is why the shell spawns from one long-lived thread. `rust-test` stubs the
 * reaper binary and never builds the crate, so those tests run only in the
 * advisory `reaper-build` job.
 *
 * ADR-051: an advisory job's guarantee is enforced by a wiring test inside
 * `check`. This one pins that the job runs `cargo test` on the reaper crate, on
 * an ubuntu leg, with nothing that would let it report success without
 * running. Steps are found by their `run` value, never by their `name`, and the
 * workflow is parsed rather than substring-matched, so a commented-out step
 * does not exist.
 */

type Step = { run?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = {
  "runs-on"?: unknown;
  if?: unknown;
  "continue-on-error"?: unknown;
  strategy?: { matrix?: { os?: unknown } };
  steps?: Step[];
};

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  jobs: Record<string, Job>;
};

const TEST_RUN = "cargo test --manifest-path reaper/Cargo.toml";

function reaperTestJob(): [string, Job, Step] {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const step = (job.steps ?? []).find(
      (s) => typeof s.run === "string" && s.run.trim() === TEST_RUN,
    );
    if (step) return [id, job, step];
  }
  throw new Error(
    `.github/workflows/ci.yml: no step runs \`${TEST_RUN}\`. Without it the Linux sidecar ` +
      "trampoline's tests (#1988) run nowhere.",
  );
}

describe("the reaper's tests run in CI (#1988, ADR-051)", () => {
  it("one job runs cargo test on the reaper crate", () => {
    const [id] = reaperTestJob();
    expect(id).toBe("reaper-build");
  });

  it("on an ubuntu leg, where the cfg(linux) tests exist", () => {
    const [, job] = reaperTestJob();
    const runsOn = String(job["runs-on"] ?? "");
    const matrixOs = job.strategy?.matrix?.os;
    const legs = Array.isArray(matrixOs) ? matrixOs.map(String) : [];
    expect(runsOn.startsWith("ubuntu") || legs.some((os) => os.startsWith("ubuntu"))).toBe(true);
  });

  it("with no if: and no continue-on-error on the step or the job", () => {
    const [, job, step] = reaperTestJob();
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
  });

  it("the test file it runs exists and holds the thread-death proof", () => {
    const source = readFileSync(path.join(ROOT, "reaper/tests/exec_pdeathsig.rs"), "utf-8");
    expect(source).toContain("fn the_child_dies_of_sigterm_when_its_forking_thread_ends()");
  });
});
