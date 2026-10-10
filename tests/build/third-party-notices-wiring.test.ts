/**
 * Pins where scripts/third-party-notices/generate.mjs is wired in, so the
 * notices cannot silently stop shipping.
 *
 * WHAT THIS IS: the cross-file couplings. The generator itself fails the build
 * when the notices would be empty, partial or stale (see its header), and
 * `verify-pack` / `verify-desktop` check the shipped result in CI. What none of
 * those can see is the generator not being RUN, or its output not being SHIPPED
 * — a build script, `files` entry, Tauri resource or workflow step quietly
 * dropped. Each assertion here is one of those links.
 *
 * Workflow steps are found by their `run` value in the PARSED file, never by
 * name or substring, for the reasons acceptance-harness-wiring.test.ts gives: a
 * commented-out step must not exist, and `if:` / `continue-on-error` must not be
 * able to neuter one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const GEN = "node scripts/third-party-notices/generate.mjs";

type Step = { run?: string; uses?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = { steps: Step[]; "continue-on-error"?: unknown; if?: unknown };
const workflow = (p: string) => parse(read(p)) as { jobs: Record<string, Job> };

function stepIndex(job: Job, pred: (s: Step) => boolean): number {
  return job.steps.findIndex(pred);
}

function expectUnconditional(job: Job, step: Step) {
  expect(step.if).toBeUndefined();
  expect(step["continue-on-error"]).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
}

describe("npm tarball", () => {
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
    files: string[];
  };

  it("`build` generates the notices as its LAST step, after every bundle exists", () => {
    expect(pkg.scripts.build.endsWith(`&& tsup && ${GEN} npm`)).toBe(true);
  });

  it("`files` ships dist/ and excludes the build-only notices inputs", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("!dist/.third-party");
    expect(pkg.files).toContain("!dist/desktop");
  });

  it("CI `check` verifies the tarball contents after the build", () => {
    const check = workflow(".github/workflows/ci.yml").jobs.check;
    const build = stepIndex(check, (s) => s.run === "npm run build");
    const verify = stepIndex(check, (s) => s.run === `${GEN} verify-pack`);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(build);
    expectUnconditional(check, check.steps[verify]);
  });
});

// No pin on tsup's `sourcemap: true`: the generator refuses any dist bundle
// without an index.js.map, at build time, which is stronger than a config read.
describe("bundle traces", () => {
  it("client CSS pulls nothing from node_modules by @import or url(), which the trace cannot see", () => {
    // A JS import of a package's CSS shows up in the chunk trace; a CSS
    // `@import` does not (verified in a scratch Vite 8 build), and the
    // generator accepts assets/*.css without a trace on the strength of this.
    const files = [
      join(ROOT, "index.html"),
      ...walk(join(ROOT, "src", "client")).filter((f) => /\.(css|svelte|html)$/.test(f)),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) {
        if (!/^\.\.?\//.test(m[1]) || m[1].includes("node_modules"))
          offenders.push(`${f}: ${m[0]}`);
      }
      for (const m of text.matchAll(/url\(\s*["']?[^"')]*node_modules[^"')]*/g)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Vite client build carries the trace plugin, writing after the files land", () => {
    const vite = read("vite.config.ts");
    expect(vite).toMatch(/plugins:\s*\[[^\]]*\bthirdPartyTrace\(\)/);
    expect(vite).toMatch(/writeBundle\(/);
  });
});

describe("desktop bundle", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    build: { beforeBuildCommand: string };
    bundle: { resources: Record<string, string> };
  };

  it("beforeBuildCommand runs desktop mode after the npm build", () => {
    expect(conf.build.beforeBuildCommand).toBe(`npm run build && ${GEN} desktop`);
  });

  it("ships the desktop notices as a bundle resource", () => {
    expect(conf.bundle.resources["../dist/desktop/THIRD_PARTY_NOTICES.txt"]).toBe(
      "THIRD_PARTY_NOTICES.txt",
    );
  });

  it("rust-test stubs the resource, since tauri_build refuses a missing one", () => {
    const job = workflow(".github/workflows/ci.yml").jobs["rust-test"];
    const stub = job.steps.find((s) =>
      s.run?.includes("touch dist/desktop/THIRD_PARTY_NOTICES.txt"),
    );
    const test = stepIndex(job, (s) => s.run?.startsWith("cargo test") ?? false);
    expect(stub).toBeDefined();
    expect(job.steps.indexOf(stub as Step)).toBeLessThan(test);
  });

  it("the release matrix verifies the bundled file after tauri-action", () => {
    const wf = workflow(".github/workflows/tauri-release.yml");
    const [name, job] = Object.entries(wf.jobs).find(([, j]) =>
      j.steps?.some((s) => s.uses?.startsWith("tauri-apps/tauri-action@")),
    ) as [string, Job];
    expect(name).toBeTruthy();
    const action = stepIndex(job, (s) => s.uses?.startsWith("tauri-apps/tauri-action@") ?? false);
    const verify = stepIndex(
      job,
      (s) => s.run === `${GEN} verify-desktop --target \${{ matrix.node-target }}`,
    );
    expect(verify).toBeGreaterThan(action);
    expectUnconditional(job, job.steps[verify]);
  });

  it("the generator's RELEASE_TRIPLES are exactly the release matrix's targets", () => {
    // The cargo "unused override" and stale reviewed-licence checks exempt
    // crates only another release target links; a drifted list would either
    // exempt a dead override or fail a live one.
    const wf = workflow(".github/workflows/tauri-release.yml") as unknown as {
      jobs: Record<
        string,
        { strategy?: { matrix?: { include?: Array<{ "node-target"?: string }> } } }
      >;
    };
    const matrix = Object.values(wf.jobs)
      .flatMap((j) => j.strategy?.matrix?.include ?? [])
      .map((e) => e["node-target"])
      .filter((t): t is string => typeof t === "string");
    const src = read("scripts/third-party-notices/generate.mjs");
    const block = /const RELEASE_TRIPLES = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(matrix.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...new Set(matrix)].sort());
  });

  it("no release leg passes cargo features, which the crate walk would not see", () => {
    // walkCrates resolves default features only; a `--features` in the matrix
    // `args` would link crates the notices never list.
    const wf = workflow(".github/workflows/tauri-release.yml") as unknown as {
      jobs: Record<string, { strategy?: { matrix?: { include?: Array<{ args?: string }> } } }>;
    };
    const args = Object.values(wf.jobs).flatMap((j) =>
      (j.strategy?.matrix?.include ?? []).map((e) => e.args ?? ""),
    );
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(a).not.toMatch(/--features|(^|\s)-F(\s|$)|--all-features/);
  });

  it("the sidecar download extracts Node's LICENSE, which desktop mode requires", () => {
    const dl = read("scripts/download-node-sidecar.mjs");
    expect(dl).toContain("node-sidecar-${targetTriple}.LICENSE");
    expect(dl).toMatch(/--strip-components=1 "\$\{prefix\}\/LICENSE"/);
  });
});
