import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Unit coverage for the v1.0 performance-gate fixture generator.
 *
 * Lives under `tests/scripts/`, NOT `tests/perf/` — Playwright's perf config
 * uses `testDir: "./"` and would collect anything it found there.
 *
 * Every case passes an explicit `--out` into a temp dir. Running the generator
 * with its default output path would have a unit test rewriting
 * `tests/perf/.generated/` from inside `npm test`, which can race a
 * concurrently-running perf gate.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GENERATOR = path.join(REPO_ROOT, "scripts", "fixtures", "make-perf-doc.mjs");

/** Mirrors `DEFAULT_ANNOTATIONS` in the generator and `EXPECTED_ANNOTATION_COUNT`
 *  in tests/perf/performance.spec.ts. All three must agree. */
const DEFAULT_ANNOTATIONS = 50;

/** Mirrors `INTERACTIVITY_SENTINEL` in tests/perf/performance.spec.ts. */
const INTERACTIVITY_SENTINEL = "zqx7";

const tmpDirs: string[] = [];

function tmpOut(name = "fixture.md"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tandem-perf-gen-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

/** Run the generator, failing the test if it exits non-zero. */
function run(args: string[]): string {
  return execFileSync(process.execPath, [GENERATOR, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run the generator, capturing a non-zero exit instead of throwing. */
function runAllowingFailure(args: string[]): { status: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [GENERATOR, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

interface SeedFile {
  seed: number;
  requested: number;
  annotations: Array<{ quote: string; text: string }>;
}

function readSeeds(outPath: string): SeedFile {
  return JSON.parse(readFileSync(outPath.replace(/\.md$/, ".annotations.json"), "utf8"));
}

/** The generator's own plain-text projection, mirrored so the uniqueness
 *  assertion checks the same string space the seeds were derived in. */
function toPlainText(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("make-perf-doc.mjs", () => {
  const out = tmpOut();
  run(["--out", out]);
  const markdown = readFileSync(out, "utf8");
  const seedFile = readSeeds(out);
  const plain = toPlainText(markdown);

  it("emits exactly DEFAULT_ANNOTATIONS seeds at the default count", () => {
    expect(seedFile.annotations).toHaveLength(DEFAULT_ANNOTATIONS);
  });

  it("records the requested count in the companion, matching what it emitted", () => {
    expect(seedFile.requested).toBe(DEFAULT_ANNOTATIONS);
    expect(seedFile.annotations).toHaveLength(seedFile.requested);
  });

  it("emits every seed quote exactly once in the document's plain-text projection", () => {
    for (const seed of seedFile.annotations) {
      const occurrences = plain.split(seed.quote).length - 1;
      expect(occurrences, `quote is not unique: ${JSON.stringify(seed.quote)}`).toBe(1);
    }
  });

  it("emits seeds in ascending document order, so the last one is the deepest", () => {
    // The harness (tests/perf/performance.spec.ts) measures create/accept
    // against `seeds.at(-1)` on exactly this basis. The generator sorts by
    // document position before writing, so this is an invariant rather than a
    // property of one seed — the probe loop itself wraps modulo and would not
    // guarantee it.
    const positions = seedFile.annotations.map((s) => plain.indexOf(s.quote));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(Math.max(...positions)).toBe(positions[positions.length - 1]);
  });

  it("does not contain the harness's interactivity sentinel", () => {
    // If it ever does, the open-to-interactive probe silently stops proving
    // anything. Pinned here as well as in the spec so a word-list change is
    // caught by `npm test` rather than by a recorded run.
    expect(markdown).not.toContain(INTERACTIVITY_SENTINEL);
  });

  it("exits non-zero when the document is too small to carry the requested load", () => {
    const shortOut = tmpOut("short.md");
    const res = runAllowingFailure(["--out", shortOut, "--words", "400", "--annotations", "50"]);
    expect(res.status).not.toBe(0);
    expect(res.output).toMatch(/requested 50 annotations, emitted/);
  });

  it("refuses an --out that is not a .md path, and writes nothing", () => {
    const badDir = mkdtempSync(path.join(os.tmpdir(), "tandem-perf-gen-"));
    tmpDirs.push(badDir);
    const badOut = path.join(badDir, "fixture.markdown");
    const res = runAllowingFailure(["--out", badOut]);
    expect(res.status).not.toBe(0);
    expect(res.output).toMatch(/--out must end in \.md/);
    // The bug this guards: `.replace(/\.md$/, …)` is a no-op on any other
    // extension, so the seed write lands on the markdown path and destroys it.
    expect(existsSync(badOut)).toBe(false);
  });
});
