import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareFileSets, EXIT_CANNOT_EVALUATE } from "../../scripts/ci/vitest-file-anchor.mjs";

/**
 * #1673 — nothing anchored files-COLLECTED against files-RUN, so a run that
 * lost files to worker starvation reported a smaller total and could exit 0.
 *
 * The comparator is pure, so every verdict here is driven with synthetic input
 * and no CI involved (the `coverage-gate.test.ts` pattern). The CLI arms —
 * which are the ones carrying the exit-code contract this whole issue is about
 * — are driven through a real subprocess at the bottom.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts/ci/vitest-file-anchor.mjs");

const abs = (rel: string) => path.resolve(ROOT, rel).replace(/\\/g, "/");
const collected = (...files: string[]) => files.map((f) => ({ file: abs(f), projectName: "node" }));
const ran = (...files: string[]) => files.map((f) => ({ name: abs(f), status: "passed" }));

describe("vitest file anchor — compareFileSets", () => {
  it("refuses a collected file that is absent from the report, by name", () => {
    // Kills a count-only anchor: the number is right for a reader who knows the
    // healthy total by heart, and for nobody else.
    const verdict = compareFileSets({
      expected: collected("tests/a.test.ts", "tests/b.test.ts"),
      reported: ran("tests/a.test.ts"),
      repoRoot: ROOT,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.cannotEvaluate).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0].kind).toBe("DID-NOT-RUN");
    expect(verdict.failures[0].file).toContain("b.test.ts");
  });

  it("refuses equal counts with different names", () => {
    // Kills the naive `expected.length === reported.length`, which passes the
    // starvation case whenever a file is ADDED in the same run — exactly the
    // shape of a PR that both adds a spec and loses one to the pool.
    const verdict = compareFileSets({
      expected: collected("tests/a.test.ts", "tests/lost.test.ts"),
      reported: ran("tests/a.test.ts", "tests/unexpected-extra.test.ts"),
      repoRoot: ROOT,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.file).join(" ")).toContain("lost.test.ts");
    // An extra file in the report is NOT a failure: the anchor asks whether
    // everything collected ran, not whether the report is a bijection.
    expect(verdict.failures).toHaveLength(1);
  });

  it("cannot evaluate on an empty collection, and never calls it a pass", () => {
    // "Zero collected" is the failure this exists to catch, never "nothing to
    // check, therefore fine" — the #1229 shape in the comparator itself.
    const verdict = compareFileSets({ expected: [], reported: ran("tests/a.test.ts") });
    expect(verdict.cannotEvaluate).toBe(true);
    expect(verdict.ok).toBe(false);
  });

  it("cannot evaluate when the report carries no testResults array", () => {
    // Kills a comparator that treats a missing report as an empty one, which
    // would make every file trivially present and every run green.
    const verdict = compareFileSets({
      expected: collected("tests/a.test.ts"),
      reported: undefined,
      repoRoot: ROOT,
    });
    expect(verdict.cannotEvaluate).toBe(true);
    expect(verdict.ok).toBe(false);
  });

  it("normalizes separators and relativeness on both sides", () => {
    const verdict = compareFileSets({
      expected: [{ file: abs("tests/a.test.ts"), projectName: "node" }],
      reported: [{ name: "tests\\a.test.ts", status: "passed" }],
      repoRoot: ROOT,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);

    const different = compareFileSets({
      expected: collected("tests/a.test.ts"),
      reported: ran("tests/other.test.ts"),
      repoRoot: ROOT,
    });
    expect(different.ok).toBe(false);
  });

  it("reduces the collected list to a set before comparing", () => {
    // `vitest list` emits one entry per (file, project) PAIR while the run
    // report carries no project. Without the Set reduction a file collected
    // under two projects is a permanent false DID-NOT-RUN — a gate that is red
    // for a reason unrelated to the diff, which is this group's whole subject.
    const verdict = compareFileSets({
      expected: [
        { file: abs("tests/shared.test.ts"), projectName: "node" },
        { file: abs("tests/shared.test.ts"), projectName: "client" },
      ],
      reported: ran("tests/shared.test.ts"),
      repoRoot: ROOT,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBe(1);
  });

  it("never reads status: a reported file RAN, whatever it reported", () => {
    // Vitest's file-level enum is `passed | failed` only, and a fully skipped
    // file reports `passed`. A status filter could only subtract from a
    // presence test — and a file that never STARTED is not a skip.
    const verdict = compareFileSets({
      expected: collected("tests/a.test.ts", "tests/b.test.ts"),
      reported: [
        { name: abs("tests/a.test.ts"), status: "failed" },
        { name: abs("tests/b.test.ts"), status: "passed" },
      ],
      repoRoot: ROOT,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("vitest file anchor — CLI exit codes", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });

  function fixture(fn: (dir: string, write: (name: string, data: unknown) => string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), "vitest-anchor-spec-"));
    try {
      fn(dir, (name, data) => {
        const p = path.join(dir, name);
        writeFileSync(p, JSON.stringify(data), "utf8");
        return p;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits 0 when every collected file is in the report", () => {
    fixture((_dir, write) => {
      const list = write("collected.json", collected("tests/a.test.ts", "tests/b.test.ts"));
      const report = write("report.json", {
        testResults: ran("tests/a.test.ts", "tests/b.test.ts"),
      });
      const r = run([report, `--expected=${list}`]);
      expect(`${r.stdout}${r.stderr}`).toContain("[vitest-file-anchor]");
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });
  });

  it("exits 1, naming the file, when a collected file never ran", () => {
    fixture((_dir, write) => {
      const list = write("collected.json", collected("tests/a.test.ts", "tests/lost.test.ts"));
      const report = write("report.json", { testResults: ran("tests/a.test.ts") });
      const r = run([report, `--expected=${list}`]);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain("lost.test.ts");
    });
  });

  it("exits 3, not 1, when the run report is missing", () => {
    // The distinction this whole script exists to create: 1 means files were
    // lost, 3 means the anchor could not tell. An uncaught throw would exit 1
    // and destroy it, which is why every acquisition path is wrapped.
    fixture((dir, write) => {
      const list = write("collected.json", collected("tests/a.test.ts"));
      const r = run([path.join(dir, "no-such-report.json"), `--expected=${list}`]);
      expect(r.status).toBe(EXIT_CANNOT_EVALUATE);
      expect(`${r.stdout}${r.stderr}`).toContain("cannot read the run report");
    });
  });

  it("exits 3 when --expected points at nothing", () => {
    fixture((dir, write) => {
      const report = write("report.json", { testResults: ran("tests/a.test.ts") });
      const r = run([report, `--expected=${path.join(dir, "no-such-list.json")}`]);
      expect(r.status).toBe(EXIT_CANNOT_EVALUATE);
      expect(`${r.stdout}${r.stderr}`).toContain("cannot read --expected");
    });
  });

  it("exits 3 when --expected is not JSON", () => {
    fixture((dir, write) => {
      const report = write("report.json", { testResults: ran("tests/a.test.ts") });
      const bad = path.join(dir, "bad.json");
      writeFileSync(bad, "not json", "utf8");
      const r = run([report, `--expected=${bad}`]);
      expect(r.status).toBe(EXIT_CANNOT_EVALUATE);
      expect(`${r.stdout}${r.stderr}`).toContain("cannot parse --expected");
    });
  });

  it("exits 3 when the report holds no testResults at all", () => {
    fixture((_dir, write) => {
      const list = write("collected.json", collected("tests/a.test.ts"));
      const report = write("report.json", { numTotalTests: 0 });
      const r = run([report, `--expected=${list}`]);
      expect(r.status).toBe(EXIT_CANNOT_EVALUATE);
      expect(`${r.stdout}${r.stderr}`).toContain(
        "The anchor could not evaluate. This is not a pass.",
      );
    });
  });

  it("keeps the comparator on disk where ci.yml points", () => {
    const r = run([]);
    expect(r.status).toBe(EXIT_CANNOT_EVALUATE);
    expect(`${r.stdout}${r.stderr}`).toContain("no path given");
  });
});
