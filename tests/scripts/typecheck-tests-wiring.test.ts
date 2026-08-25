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
  needs?: unknown;
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

/**
 * The script the CI step delegates to, pinned by EXACT equality.
 *
 * Pinning only the `ci.yml` step is not enough, and a review caught this: the
 * step's whole body is `npm run typecheck:tests`, so appending `|| true` to the
 * script below leaves `step.run` byte-identical and every CI-level assertion
 * green while the gate reports success unconditionally. That is #1229's exact
 * shape, reachable by the edit most likely to be made under pressure. Three
 * `toContain` checks on the config filenames -- what this used to be -- are
 * satisfied by `echo tsconfig.tests.node.json ...` too.
 */
const SCRIPT =
  "tsc -p tsconfig.tests.node.json --noEmit && " +
  "tsc -p tsconfig.tests.client.json --noEmit && " +
  "tsc -p tsconfig.tests.e2e.json --noEmit";

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

/** Resolve a tsconfig to the compiler options `tsc` would actually apply. */
function resolvedOptions(configName: string): ts.CompilerOptions {
  const configPath = path.join(ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath).options;
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

  it("delegates to a script that cannot mask its own exit code", () => {
    const script = pkg.scripts["typecheck:tests"];
    expect(script, "package.json has no typecheck:tests script").toBeTruthy();
    // Exact equality, for the reason on SCRIPT above. A `toContain` per config
    // name is satisfied by `... || true` and by `echo <the three names>`.
    expect(script?.trim()).toBe(SCRIPT);
    // Kept as a readable failure message when the exact match goes red.
    for (const config of TEST_CONFIGS) {
      expect(script, `${config} is not checked by typecheck:tests`).toContain(config);
    }
  });

  it("does not let the job be skipped by a failing dependency", () => {
    // A skipped job's check-run conclusion counts as passing for required status
    // checks, so `needs: <anything that can fail>` silently disarms the gate.
    // windows-acl-proof-wiring.test.ts pins exactly this; the first version of
    // this file, modelled on it, dropped the line.
    const [, job] = typecheckJob();
    expect(job.needs, "a `needs:` makes this job skip when its dependency fails").toBeUndefined();
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
      // Deliberately WIDER than the configs' `**/*.ts` globs. If this swept only
      // `.ts`, a file renamed to `.mts`/`.cts`/`.tsx` would drop out of every
      // config AND out of this check at the same moment -- a coverage guard whose
      // blind spot is identical to the thing it guards catches nothing. Sweeping
      // wider means such a rename surfaces here as an orphan.
      //
      // `node_modules` is excluded for speed and correctness: without it this
      // walks tauri-driver's 3,441 vendored files, and a node_modules appearing
      // anywhere else under tests/ would turn the guard spuriously red.
      .readDirectory(
        path.join(ROOT, "tests"),
        [".ts", ".mts", ".cts", ".tsx"],
        ["node_modules"],
        undefined,
      )
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      // `tests/tauri-driver` is a self-contained WebdriverIO project with its own
      // package.json, node_modules and tsconfig.
      //
      // This carve-out used to claim "It is checked, just not by these configs."
      // That was false and a review measured it: its package.json runs only
      // `wdio run` (transpile-only, no tsc), nothing in package.json, ci.yml or
      // .husky invokes `tsc -p tests/tauri-driver/tsconfig.json`, and
      // tauri-webdriver.yml is `workflow_dispatch` only. Running that config by
      // hand reports a real TS2353 in `wdio.conf.ts` that has been sitting there
      // unseen -- an unrun tsconfig, which is #1399's shape.
      //
      // It stays excluded here because folding it into `typecheck:tests` needs CI
      // to install its separate node_modules, which is a bigger change than this
      // unit. The exclusion is correct; only its old justification was not.
      .filter((f) => !f.startsWith("tests/tauri-driver/"));

    const orphans = all.filter((f) => !owned.has(f));
    expect(
      orphans,
      "these test files are in no tsconfig — a whole directory was added without an owner, " +
        "or an `include` was narrowed to a suffix glob. Either way they are unchecked and " +
        "nothing else would have said so.",
    ).toEqual([]);
  });

  it("covers named files the orphan sweep cannot see", () => {
    const owned = new Set(TEST_CONFIGS.flatMap((c) => resolvedFiles(c)));
    // The orphan check above walks `tests/` ONLY, so everything these configs
    // pull in from elsewhere is undefended by it. A review measured that:
    // narrowing the e2e config's include to just its two `tests/**` lines drops
    // 10 files and leaves every other assertion in this file green.
    //
    // So the representatives that earn their place are the ones OUTSIDE
    // `tests/`. The in-tree ones below are kept only as readable failure
    // messages -- if `orphans` is empty they are owned unconditionally, which is
    // why an earlier version of this list proved nothing.
    for (const representative of [
      // Outside tests/ — the half the orphan sweep is blind to.
      "playwright.config.ts", // a standalone config, loaded by path
      "scripts/screenshots/playwright.config.ts",
      "scripts/design-baselines/playwright.config.ts",
      "src/client/utils/backend-ports.ts", // client module the e2e program needs
      "src/server/express.d.ts", // ambient decl, included by path in the client config
      // Inside tests/ — kinds that carry no `.test.ts` suffix.
      "tests/helpers/positions.ts", // a helper module, imported
      "tests/perf/global-setup.ts", // loaded by path by Playwright, imported by nothing
      "tests/e2e/helpers.ts", // a harness, imported
      "tests/build/dangling-citations.ts", // a script that carries no describe/it
      "tests/helpers/wizard-progress-cell.svelte.ts", // a rune cell, client config only
    ]) {
      expect(owned.has(representative), `${representative} is unchecked`).toBe(true);
    }
  });
});

describe("the test configs check as hard as they appear to", () => {
  // Every assertion above is about WHICH files are in the program. None is about
  // how hard they are checked -- and a review measured that setting
  // `strict: false` in all three configs changes no resolved file set, leaves
  // orphans empty, and passes every other test here.
  //
  // That is the likeliest real regression: this unit exists because ~900 type
  // errors were sitting in `tests/`, and loosening a compiler option is by far
  // the cheapest way to drive that count to zero without fixing anything.
  //
  // All three `extends` the root config, so ONE `"strict": false` there guts
  // this gate and `Typecheck (root|client|server)` in the same edit.
  it("resolves to strict options in every config", () => {
    for (const config of TEST_CONFIGS) {
      const options = resolvedOptions(config);
      expect(options.strict, `${config} is not strict`).toBe(true);
      expect(options.noImplicitAny, `${config} allows implicit any`).not.toBe(false);
      expect(options.strictNullChecks, `${config} has null checks off`).not.toBe(false);
    }
  });
});

describe("every source directory is checked by something CI runs", () => {
  /**
   * The unit's own instruction asks for this, and it is a different question
   * from the one above: not "is `tests/` covered" but "can a file under `src/`
   * sit in no program any CI step invokes".
   *
   * The config list is DERIVED from `ci.yml`, never hardcoded. A hardcoded list
   * keeps passing after the step that ran one of them is deleted -- it would be
   * asserting against a config nothing invokes, which is the failure this whole
   * file exists to prevent.
   */
  function configsCiInvokes(): string[] {
    const [, job] = typecheckJob();
    const found = new Set<string>();
    for (const step of job.steps ?? []) {
      const run = typeof step.run === "string" ? step.run : "";
      if (!/(^|\s)(npx\s+)?tsc(\s|$)/.test(run) && !run.includes("typecheck:tests")) continue;
      // `npm run typecheck:tests` fans out to the three test configs.
      if (run.includes("typecheck:tests")) {
        for (const c of TEST_CONFIGS) found.add(c);
        continue;
      }
      const project = run.match(/-p\s+(\S+)/);
      // A bare `tsc --noEmit` with no -p resolves the root config.
      found.add(project ? project[1] : "tsconfig.json");
    }
    return [...found];
  }

  it("derives its config list from ci.yml rather than trusting one", () => {
    const configs = configsCiInvokes();
    // Positive control: if the regex above stops matching, this describe would
    // otherwise pass vacuously against an empty set.
    expect(configs.length, "no tsc invocation found in the CI job").toBeGreaterThan(2);
    expect(configs).toContain("tsconfig.json");
    for (const c of TEST_CONFIGS) expect(configs).toContain(c);
  });

  it("leaves no file under src/ unchecked", () => {
    const owned = new Set(configsCiInvokes().flatMap((c) => resolvedFiles(c)));
    const all = ts.sys
      .readDirectory(
        path.join(ROOT, "src"),
        [".ts", ".mts", ".cts", ".tsx"],
        ["node_modules"],
        undefined,
      )
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));

    const unchecked = all.filter((f) => !owned.has(f));
    expect(
      unchecked,
      "these source files are in no config any CI step invokes. `src/cli` was " +
        "the historical instance -- reachable only through the root `tsc` inside " +
        "`npm run build`, ten minutes into the job and behind unrelated failures.",
    ).toEqual([]);
  });
});

describe("docs match the wiring", () => {
  // Both predecessor guards end with a block like this, and the first version of
  // this file had none. That mattered more here than usual: `typecheck:tests`
  // appeared in ZERO tracked docs, so deleting this file and the CI step would
  // have turned nothing red, left no claim dangling, and told no future reader
  // the gate had ever existed. #1399 was a doc claiming less coverage than
  // existed; an undocumented gate is the same failure with no paper trail at all.
  const claudeMd = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf-8");

  it("CLAUDE.md names the script that typechecks the test tree", () => {
    expect(claudeMd).toMatch(/typecheck:tests/);
  });

  it("CLAUDE.md names this guard", () => {
    expect(claudeMd).toMatch(/typecheck-tests-wiring/);
  });
});
