import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const manifestScript = readFileSync(path.join(ROOT, "scripts/ci/coverage-manifest.mjs"), "utf-8");
const vitestConfigRaw = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf-8");

/**
 * The config with `//` comments stripped.
 *
 * Every check below is a source-shape check, and the comments in
 * `vitest.config.ts` quote the very patterns those checks forbid -- the
 * negated-include finding is written out verbatim there so the next reader
 * knows why it must not come back. Matching against the raw text therefore
 * fails on the explanation rather than the code. Learned the expensive way:
 * the first version of this file did exactly that and reported the fixed
 * config as broken.
 */
const vitestConfig = vitestConfigRaw
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

/**
 * Unit 3 publishes a coverage BASELINE, and Unit 13 turns the numbers in it
 * into enforced per-module floors with at most a one-point rounding allowance.
 * So the failure that matters here is not "coverage dropped" -- nothing gates
 * on the level yet, deliberately. It is the baseline being produced by a run
 * that measured less than it appears to, because that error is invisible in the
 * output and gets frozen into a gate later.
 *
 * This repo has produced that exact shape three times (#1229, #1399, #1529).
 * It produced it again here: see the negated-include finding below.
 */
describe("the coverage baseline measures what it claims", () => {
  it("keeps the node project's exclusion out of `include`", () => {
    // THE BUG THIS UNIT FOUND, and the reason the rest of this file exists.
    //
    // `include: ["tests/**/*.test.ts", "!tests/client/**/*.test.ts"]` selects
    // exactly the right 324 files -- verified by diffing
    // `vitest list --project=node --filesOnly` across both spellings -- and
    // collects NO V8 coverage for any of them. Measured: with the negation,
    // `vitest run --project=node <test> --coverage` reports `Unknown% ( 0/0 )`
    // and exits 0. A run spanning both projects aggregates to the same 0/0, so
    // EVERY whole-suite coverage run reported nothing, successfully.
    //
    // Pinned as a source-shape check rather than by running coverage, because
    // running it costs six minutes and this has to be cheap enough to sit in
    // the ordinary suite.
    const nodeProject = vitestConfig.slice(vitestConfig.indexOf('name: "node"'));
    const include = nodeProject.slice(
      nodeProject.indexOf("include:"),
      nodeProject.indexOf("]", nodeProject.indexOf("include:")),
    );
    expect(
      include,
      "a negated pattern in the node project's `test.include` silently disables V8 " +
        "coverage for every file it selects. Use `exclude` instead.",
    ).not.toContain('"!');
  });

  it("scopes coverage to every measurable source family, not just .ts", () => {
    // `include: ["src/**/*.ts"]` cannot match a bare `.svelte` filename, so all
    // 101 components were absent from the report -- which in the output is
    // indistinguishable from being measured at 0%. They ARE measurable:
    // rendering ActivityTray.svelte reports it at 88.62% statements, and
    // Root.svelte's uncovered range is 6-7, its only two markup lines.
    const cov = vitestConfig.slice(vitestConfig.indexOf("coverage: {"));
    expect(cov).toContain('"src/**/*.ts"');
    expect(cov, "Svelte components are measurable here; see the config comment").toContain(
      '"src/**/*.svelte"',
    );
  });

  it("declares coverage at the root, where projects cannot shadow it", () => {
    // `TestProject._configureServer` overwrites a project-level `coverage` with
    // the root's unconditionally, and the types are identical at both levels --
    // so a per-project block is discarded with no error anywhere.
    const projectsAt = vitestConfig.indexOf("projects: [");
    const coverageAt = vitestConfig.indexOf("coverage: {");
    const projectsEnd = vitestConfig.indexOf("\n    ],", projectsAt);
    expect(projectsAt).toBeGreaterThan(-1);
    expect(coverageAt, "coverage must sit outside the `projects` array").toBeGreaterThan(
      projectsEnd,
    );
  });

  it("ships the provider it names", () => {
    // Without `@vitest/coverage-v8`, `vitest --coverage` exits 1 with
    // MISSING DEPENDENCY before collecting anything -- loud, which is right.
    // Pinned so the script cannot outlive the dependency.
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeDefined();
    expect(vitestConfig).toContain('provider: "v8"');
  });

  it("runs the manifest step, and cannot skip it on a failed measurement", () => {
    const script = pkg.scripts["test:coverage"];
    expect(script, "no test:coverage script").toBeDefined();
    expect(script).toContain("node scripts/ci/coverage-manifest.mjs");
    // `&&`, never `;` or `||`. A `;` would emit a manifest from whatever stale
    // summary was on disk after a failed run; a `||` would emit one INSTEAD of
    // failing. Both publish a number that no run produced.
    expect(script).toContain("&& node scripts/ci/coverage-manifest.mjs");
    expect(script).not.toContain("|| node scripts/ci/coverage-manifest.mjs");
    expect(script).not.toContain("; node scripts/ci/coverage-manifest.mjs");
    // The json-summary reporter is what the manifest reads. Without it the
    // script fails closed, but failing for a missing-file reason reads as a
    // broken script rather than a missing reporter.
    expect(script).toContain("json-summary");
  });

  it("refuses a zero measurement rather than reporting 0%", () => {
    // The distinction the whole artifact turns on: `0%` means the code is
    // untested, `0/0` means nothing was looked at. They demand opposite
    // responses and are one character apart in a summary.
    expect(manifestScript).toContain("total.statements.total === 0");
    expect(manifestScript).toContain("process.exit(1)");
  });

  it("lists every suspended timing assertion, with none missing", () => {
    // `expectWithinMs` no-ops under TANDEM_COVERAGE=1 because a wall-clock upper
    // bound measures the profiler during an instrumented run. That is a real
    // reduction in what the coverage run verifies, so the artifact has to name
    // the sites -- and this asserts the named set IS the actual set, so a fourth
    // call site cannot appear and go unmentioned.
    // Two files match this grep without being suspended sites, and both are
    // excluded by DERIVING their paths rather than writing them as literals --
    // a literal is itself a match, which is the trap this went through twice.
    //
    //   - `tests/helpers/timing.ts` declares the helper. Its definition line is
    //     a call-shaped match; it is the module referenced, never a site.
    //   - THIS file, whose grep argument and failure message both contain the
    //     name. Narrowing the pattern to the call form `expectWithinMs(` did not
    //     help: that string then appears here too, one level deeper.
    //
    // Worth recording why the original defect survived every run of this test
    // and all eight mutation proofs. `git grep` searches TRACKED files, and this
    // file was untracked until the commit that introduced it -- so it passed by
    // being invisible to its own search. A green result is only evidence if a
    // broken version would have looked different, and before `git add` no
    // version of this could have looked different. Any self-scanning check has
    // that blind spot for exactly as long as it is new.
    const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, "/");
    const HELPER = path
      .relative(ROOT, fileURLToPath(new URL("../helpers/timing.ts", import.meta.url)))
      .replace(/\\/g, "/");

    const found = execFileSync("git", ["grep", "-l", "expectWithinMs", "--", "tests/"], {
      cwd: ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== HELPER && f !== SELF)
      .sort();

    const declared = [
      ...manifestScript.matchAll(/SUSPENDED_TIMING_SITES[\s\S]*?\[([\s\S]*?)\]/g),
    ][0]?.[1];
    expect(declared, "coverage-manifest.mjs has no SUSPENDED_TIMING_SITES list").toBeDefined();

    for (const file of found) {
      expect(declared, `${file} calls expectWithinMs but the manifest does not list it`).toContain(
        file,
      );
    }
    const listedCount = (declared as string).split('"').filter((s) => s.includes("tests/")).length;
    expect(listedCount, "the manifest lists a site that no longer exists").toBe(found.length);
  });

  it("publishes the artifact from CI without gating on the level", () => {
    const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
      jobs: Record<
        string,
        {
          steps?: {
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
            if?: string;
          }[];
          "continue-on-error"?: boolean;
        }
      >;
    };
    const job = workflow.jobs.coverage;
    expect(job, "no `coverage` job in ci.yml").toBeDefined();

    const steps = job.steps ?? [];
    const run = steps.find((s) => s.run?.includes("test:coverage"));
    expect(run, "the coverage job never runs test:coverage").toBeDefined();
    // No `|| true` on the measurement. The unit's instruction is that no
    // repository-wide THRESHOLD is enforced -- that is a statement about the
    // coverage level, not a licence for the job to pass when it could not
    // measure. Those are different questions and #1229 is what conflating them
    // costs.
    expect(run?.run).not.toContain("|| true");
    expect(run?.run).not.toContain("continue-on-error");

    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload, "the coverage job produces no artifact").toBeDefined();
    // Uploaded unconditionally, not `if: success()`: the manifest is most worth
    // reading on the run where something went wrong.
    expect(upload?.if ?? "always()").toContain("always()");
  });
});
