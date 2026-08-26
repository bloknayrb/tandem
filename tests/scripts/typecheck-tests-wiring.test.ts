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
      // The exclude MUST be `**/node_modules`, not a bare `node_modules`.
      // `ts.sys.readDirectory` resolves exclude patterns against the root, so
      // the bare form matches only `<root>/node_modules` and does nothing here.
      // Measured over `tests/`: bare form 4,389 files, `**/` form 640, no
      // exclude 4,389 -- the vendored tauri-driver tree was being removed purely
      // by the prefix filter below, and a `node_modules` appearing anywhere else
      // under tests/ would have turned the guard spuriously red.
      .readDirectory(
        path.join(ROOT, "tests"),
        [".ts", ".mts", ".cts", ".tsx"],
        ["**/node_modules"],
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

  it("sweeps the harness directories, not just a representative from each", () => {
    // A representative list cannot see a narrowing that KEEPS the
    // representative. Measured: replacing `scripts/screenshots/**/*.ts` with
    // `scripts/screenshots/playwright.config.ts` (and the same for
    // design-baselines) in tsconfig.tests.e2e.json silently drops six files --
    // capture.spec.ts, redact-account.ts, combine.ts, global-setup.ts,
    // global-teardown.ts -- while every named representative stays owned. That
    // is MUT-4's own failure mode relocated, so these two directories get a real
    // sweep rather than a spot check.
    const owned = new Set(TEST_CONFIGS.flatMap((c) => resolvedFiles(c)));
    for (const dir of ["scripts/screenshots", "scripts/design-baselines"]) {
      const all = ts.sys
        .readDirectory(path.join(ROOT, dir), [".ts", ".mts", ".cts", ".tsx"], ["**/node_modules"])
        .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
      expect(all.length, `${dir} resolved no files — has it moved?`).toBeGreaterThan(0);
      expect(
        all.filter((f) => !owned.has(f)),
        `these ${dir} files are in no test config`,
      ).toEqual([]);
    }
  });
});

describe("the test configs cannot be narrowed by a suffix glob", () => {
  it("includes whole directories, never a suffix glob", () => {
    // The configs' own comments state this as an absolute, and a review
    // measured that nothing enforced it: narrowing `"tests/server/**/*.ts"` to
    // `"tests/server/**/*.test.ts"` leaves every other assertion in this file
    // green, because every file under `tests/server` already ends `.test.ts`.
    // The orphan sweep is a real backstop for a file that exists TODAY, but it
    // cannot object to a glob that is merely waiting to skip the next helper
    // someone adds -- and skipping is indistinguishable from passing.
    //
    // The one sanctioned exception is `tests/*.test.ts`, which exists so the
    // two suites at the root of `tests/` are covered without dragging every
    // sibling directory in twice. It is spelled out here rather than pattern-
    // matched, so adding a second exception is a deliberate edit to this test.
    const ALLOWED_SUFFIX_GLOBS = new Set(["tests/*.test.ts"]);

    for (const config of TEST_CONFIGS) {
      const configPath = path.join(ROOT, config);
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      const include = (read.config as { include?: string[] }).include ?? [];
      expect(include.length, `${config} has no include list`).toBeGreaterThan(0);

      for (const pattern of include) {
        if (ALLOWED_SUFFIX_GLOBS.has(pattern)) continue;
        // A single named file (`src/server/express.d.ts`) is not a glob and is
        // not what this guards against.
        if (!pattern.includes("*")) continue;
        expect(
          pattern.endsWith("/**/*.ts"),
          `${config}: include "${pattern}" is a suffix glob, not a whole directory. ` +
            "It silently skips every helper and fixture-builder no matched file imports.",
        ).toBe(true);
      }
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
    // Every flag in the strict family, via the compiler's own resolver rather
    // than three by hand. A re-review measured that `strict: true` stays true
    // while `strictFunctionTypes`, `strictBindCallApply`,
    // `strictPropertyInitialization`, `noImplicitThis`,
    // `useUnknownInCatchVariables` or `alwaysStrict` are individually turned
    // off. `strictFunctionTypes` is the one that matters most here: it is
    // parameter-variance checking, which is where the signature-drift cluster
    // this unit fixed actually lived.
    const STRICT_FAMILY = [
      "strict",
      "noImplicitAny",
      "strictNullChecks",
      "strictFunctionTypes",
      "strictBindCallApply",
      "strictPropertyInitialization",
      "noImplicitThis",
      "useUnknownInCatchVariables",
      "alwaysStrict",
    ] as const;

    // `ts.getStrictOptionValue` is the compiler's own resolver for exactly this
    // and it exists at runtime, but it is NOT in TypeScript's public typings --
    // so calling it is TS2339 under the very gate this file installs. Inlined
    // instead. The rule it implements: a member of the family is on when set
    // explicitly, and otherwise inherits `strict`.
    const strictOptionValue = (options: ts.CompilerOptions, flag: (typeof STRICT_FAMILY)[number]) =>
      options[flag] ?? options.strict ?? false;

    for (const config of TEST_CONFIGS) {
      const options = resolvedOptions(config);
      for (const flag of STRICT_FAMILY) {
        expect(strictOptionValue(options, flag), `${config}: ${flag} is off`).toBe(true);
      }
      // Earned coverage nothing else defends: the test tree passes with these,
      // and they are what surfaced the dead imports and directives in this unit.
      expect(options.noUnusedLocals, `${config} allows unused locals`).not.toBe(false);
      expect(options.noUnusedParameters, `${config} allows unused params`).not.toBe(false);
    }
  });

  it("is not silenced wholesale by noCheck", () => {
    // `noCheck: true` is a TOTAL kill switch and it is one word. TS honours it
    // from tsconfig, alongside `--noEmit`, and reports nothing at all -- while
    // `strict` and every flag above stay true, every file set is unchanged, and
    // every other assertion in this file passes. Measured against this repo's
    // TypeScript: a tsconfig with strict + noEmit + noCheck compiles
    // `const x: number = "nope"` to exit 0; drop noCheck and it is TS2322.
    //
    // Checked on the root config too, since all five programs extend it and one
    // word there disarms `Typecheck (tests|root|client|server)` together.
    for (const config of [...TEST_CONFIGS, "tsconfig.json"]) {
      expect(resolvedOptions(config).noCheck, `${config} sets noCheck`).not.toBe(true);
    }
  });

  it("keeps the production configs strict too", () => {
    // The comment above is right that one `strict: false` in the ROOT config
    // guts everything -- but `tsconfig.server.json` and `tsconfig.client.json`
    // can each set it locally, and nothing here reads their options. The `src/`
    // block below resolves their file NAMES only, so `Typecheck (server)` could
    // go soft over src/server, src/shared, src/channel and src/monitor with all
    // of this green.
    for (const config of ["tsconfig.json", "tsconfig.server.json", "tsconfig.client.json"]) {
      expect(resolvedOptions(config).strict, `${config} is not strict`).toBe(true);
    }
  });
});

describe("no file under src/ escapes every CI-invoked config", () => {
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
  /**
   * Returns the configs, and separately how many came from a REAL parsed tsc
   * invocation rather than from the `typecheck:tests` fan-out. The split
   * matters: see the control test below.
   */
  function configsCiInvokes(): { configs: string[]; parsedTscSteps: number } {
    const [, job] = typecheckJob();
    const found = new Set<string>();
    let parsedTscSteps = 0;

    for (const step of job.steps ?? []) {
      const run = typeof step.run === "string" ? step.run : "";
      if (!/(^|\s)(npx\s+)?tsc(\s|$)/.test(run) && !run.includes("typecheck:tests")) continue;
      // `npm run typecheck:tests` fans out to the three test configs.
      if (run.includes("typecheck:tests")) {
        for (const c of TEST_CONFIGS) found.add(c);
        continue;
      }

      // Both spellings, and EVERY occurrence -- a multi-line `run:` can hold
      // more than one, and taking only the first silently drops the rest.
      const projects = [...run.matchAll(/(?:-p|--project)\s+(\S+)/g)].map((m) => m[1]);
      if (projects.length > 0) {
        for (const p of projects) found.add(p);
        continue;
      }

      // A BARE `tsc --noEmit` resolves the root config -- but only a bare one.
      // This used to fall back to "tsconfig.json" for any unparsed tsc-ish run,
      // which was the hole: root's `include: ["src"]` covers every file under
      // src/, so the check below reduces to "is the string tsconfig.json in the
      // list", and the fallback MANUFACTURED that string. A re-review showed
      // `run: echo npx tsc --noEmit` scoring identically to the real step.
      //
      // Anchored at `^`, not `(^|\s)`: with the looser opening, a literal
      // `run: echo npx tsc --noEmit` matched from the space before `npx` and
      // scored as a real invocation. Only a trailing word made it fail, which
      // is why the mutation that caught this used one.
      //
      // The flag repetition is `--?[A-Za-z][\w-]*`, and the letter is what
      // makes it safe. `--?[\w-]+` lets a `-` be consumed by either the `--?`
      // or the character class, so `-- -- --` has exponentially many parses:
      // CodeQL flagged it as js/redos on this very file. The input is a
      // tracked workflow rather than anything hostile, but an ambiguity this
      // cheap to remove is not worth arguing about.
      if (/^(npx\s+)?tsc(\s+--?[A-Za-z][\w-]*)*\s*$/.test(run.trim())) {
        found.add("tsconfig.json");
        parsedTscSteps++;
        continue;
      }

      throw new Error(
        `.github/workflows/ci.yml: step ${JSON.stringify(step.name ?? run)} looks like a tsc ` +
          `invocation but no project could be resolved from it. Refusing to guess -- see ` +
          `tests/scripts/typecheck-tests-wiring.test.ts.`,
      );
    }
    parsedTscSteps += found.size - TEST_CONFIGS.length - (found.has("tsconfig.json") ? 1 : 0);
    return { configs: [...found], parsedTscSteps };
  }

  it("derives its config list from ci.yml rather than trusting one", () => {
    const { configs, parsedTscSteps } = configsCiInvokes();
    // The real control, and the reason it counts PARSED steps rather than
    // `configs.length`: the `typecheck:tests` branch adds three configs with no
    // regex match at all, so a length check is satisfied by that fan-out alone
    // and stays green after every `Typecheck (client|server|root)` step is
    // deleted. An earlier version claimed to guard this and did not.
    expect(parsedTscSteps, "no directly-parsed tsc step found in the CI job").toBeGreaterThan(0);
    expect(configs).toContain("tsconfig.json");
    expect(configs).toContain("tsconfig.client.json");
    expect(configs).toContain("tsconfig.server.json");
    for (const c of TEST_CONFIGS) expect(configs).toContain(c);
  });

  it("leaves no file under src/ unchecked", () => {
    const owned = new Set(configsCiInvokes().configs.flatMap((c) => resolvedFiles(c)));
    const all = ts.sys
      .readDirectory(
        path.join(ROOT, "src"),
        [".ts", ".mts", ".cts", ".tsx"],
        ["**/node_modules"],
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
