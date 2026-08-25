import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Guard on the wiring that first brought `tests/` into a typechecked program.
 *
 * Before this unit, no tsconfig `include` reached the test tree at all --
 * `tsconfig.json` covers `src`, and the client/server configs cover subsets of
 * it. So ~900 type errors sat in `tests/` indefinitely, and two `expectTypeOf`
 * "contract tests" asserted nothing in every CI run since they were written
 * (`vitest` has no `typecheck` block, and `expect-type`'s runtime methods are
 * `() => true`).
 *
 * Modelled on `windows-acl-proof-wiring.test.ts` and
 * `acceptance-harness-wiring.test.ts`, and for the same reason: this repo's
 * repeat failure mode is a gate that reports success when it did not evaluate
 * (#1229, #1399, #1529). So this file PARSES `ci.yml` rather than
 * substring-matching it, locates the step by its `run:` value rather than its
 * prose `name:`, and THROWS instead of returning a sentinel when a step is
 * missing -- an assertion built on a -1 index passes vacuously the moment the
 * thing it orders is deleted.
 *
 * The assertion that matters most is the last describe block. `tsc` fails
 * closed on a *completely* empty input set (TS18003), so an `include` that
 * matches nothing is not the risk. The risk is a PARTIAL glob: measured in a
 * scratch project, `include: ["**\/*.test.ts"]` skipped a sibling `.spec.ts`
 * holding a real type error with no diagnostic, no warning, and exit 0. So the
 * configs include whole directories, and the check below is that every
 * executable `.ts` under `tests/` actually lands in one of them.
 */

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  shell?: unknown;
};
type Defaults = { run?: { shell?: unknown } };
type Job = {
  "runs-on"?: unknown;
  if?: unknown;
  "continue-on-error"?: unknown;
  defaults?: Defaults;
  steps: Step[];
};

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  on: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

const COMMAND = "npm run typecheck:tests";

const TEST_CONFIGS = [
  "tsconfig.tests.node.json",
  "tsconfig.tests.client.json",
  "tsconfig.tests.e2e.json",
] as const;

/** Locate the job running the command, never by job id or prose name. */
function typecheckJob(): [string, Job] {
  const match = Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some((s) => typeof s.run === "string" && s.run.includes("typecheck:tests")),
  );
  if (!match) {
    throw new Error(
      `.github/workflows/ci.yml: no job runs \`${COMMAND}\`. The test tree has no typecheck ` +
        `runner again — see tests/scripts/typecheck-tests-wiring.test.ts.`,
    );
  }
  return match;
}

function stepIndex(job: Job, label: string, predicate: (s: Step) => boolean): number {
  const index = (job.steps ?? []).findIndex(predicate);
  if (index < 0) {
    throw new Error(`.github/workflows/ci.yml: the typecheck job has no step ${label}`);
  }
  return index;
}

/** Resolve a tsconfig to the exact file list `tsc` would compile — no typecheck. */
function resolvedFiles(configName: string): string[] {
  const configPath = path.join(ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configName} failed to parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath);
  expect(parsed.errors.filter((e) => e.code !== 18003)).toEqual([]);
  return parsed.fileNames.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
}

describe("typecheck:tests CI wiring", () => {
  it("runs from a job, as a bare command", () => {
    const [, job] = typecheckJob();
    const step =
      job.steps[stepIndex(job, COMMAND, (s) => s.run?.includes("typecheck:tests") ?? false)];
    // Exact equality, not `toContain`. It subsumes the whole exit-code-masking
    // family in one assertion — `|| true`, `; true`, `|| echo ...`, `set +e &&`,
    // a trailing pipe — which a denylist only ever covers partly.
    expect(step.run?.trim()).toBe(COMMAND);
  });

  it("is unconditional and blocking, at step, job and workflow level", () => {
    const [, job] = typecheckJob();
    const step =
      job.steps[stepIndex(job, COMMAND, (s) => s.run?.includes("typecheck:tests") ?? false)];
    expect(step.if, "an `if:` can silence the gate while leaving it visible").toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(
      job["continue-on-error"],
      "a job-level continue-on-error masks every step",
    ).toBeUndefined();
    expect(job.if).toBeUndefined();
    // A non-default shell cascades: `shell: bash` under GitHub sets -eo pipefail,
    // and a custom shell can drop the failure entirely.
    expect(step.shell).toBeUndefined();
    expect(job.defaults?.run?.shell).toBeUndefined();
    expect(workflow.defaults?.run?.shell).toBeUndefined();
  });

  it("fires on pull requests without a branch or path filter", () => {
    // A `branches:`/`paths-ignore:` filter keeps the key present while the gate
    // never runs on a PR to master.
    expect(Object.keys(workflow.on)).toContain("pull_request");
    expect(workflow.on.pull_request).toBeNull();
  });

  it("runs after dependencies are installed", () => {
    const [, job] = typecheckJob();
    const install = stepIndex(job, "`npm ci`", (s) => s.run?.trim() === "npm ci");
    const check = stepIndex(job, COMMAND, (s) => s.run?.includes("typecheck:tests") ?? false);
    expect(check).toBeGreaterThan(install);
  });

  it("checks every test config, so none can be dropped from the script", () => {
    const script = pkg.scripts["typecheck:tests"];
    expect(script, "package.json has no typecheck:tests script").toBeTruthy();
    for (const config of TEST_CONFIGS) {
      expect(script, `${config} is not checked by typecheck:tests`).toContain(config);
    }
  });
});

describe("the test configs actually reach the test tree", () => {
  it("each config resolves a non-empty file set", () => {
    // `tsc` exits 2 on a completely empty set (TS18003), so this is the cheap
    // half. The next test is the half that matters.
    for (const config of TEST_CONFIGS) {
      expect(resolvedFiles(config).length, `${config} resolves no files`).toBeGreaterThan(0);
    }
  });

  it("every executable .ts under tests/ belongs to at least one config", () => {
    const owned = new Set(TEST_CONFIGS.flatMap((c) => resolvedFiles(c)));
    const all = ts.sys
      .readDirectory(path.join(ROOT, "tests"), [".ts"], undefined, undefined)
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      // `tests/tauri-driver` is a self-contained WebdriverIO project with its own
      // package.json, node_modules and tsconfig, run by `npm run
      // test:tauri-driver`. It is checked, just not by these configs.
      .filter((f) => !f.startsWith("tests/tauri-driver/"));

    const orphans = all.filter((f) => !owned.has(f));
    expect(
      orphans,
      "these test files are in no tsconfig — a whole directory was added without an owner, " +
        "or an `include` was narrowed to a suffix glob. Either way they are unchecked and " +
        "nothing else would have said so.",
    ).toEqual([]);
  });

  it("covers file kinds a suffix glob would have missed", () => {
    const owned = new Set(TEST_CONFIGS.flatMap((c) => resolvedFiles(c)));
    // Positive control with named representatives, one per kind. Without this a
    // config narrowed to `**/*.test.ts` still passes every assertion above:
    // the set is non-empty, and the orphan check would go red only if someone
    // noticed. These are the kinds that carry no `.test.ts` suffix and that
    // nothing necessarily imports.
    for (const representative of [
      "tests/helpers/positions.ts", // a helper module, imported
      "tests/perf/global-setup.ts", // loaded by path by Playwright, imported by nothing
      "tests/e2e/helpers.ts", // a harness, imported
      "tests/build/dangling-citations.ts", // a script that carries no describe/it
    ]) {
      expect(owned.has(representative), `${representative} is unchecked`).toBe(true);
    }
  });
});
