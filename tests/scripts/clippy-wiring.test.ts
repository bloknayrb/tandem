import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Pins clippy inside the required `rust-test` legs.
 *
 * What would let it go quiet without failing: the step leaving the job, losing
 * `-D warnings` (clippy then only prints), losing `--all-targets` (test code is
 * unlinted), skipping the windows leg (the `cfg(windows)` code is invisible to a
 * Linux clippy), gaining `continue-on-error`, or tracking `stable` (a lint added
 * in a new Rust release would turn every open PR red at once, and the cheapest
 * fix in that moment is deleting the step). Steps are found by their `run`
 * value and the workflow is parsed, so a commented-out step does not count.
 */

type Step = { run?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = { strategy?: { matrix?: { os?: string[] } }; steps?: Step[] };

const ci = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

describe("clippy runs in the required rust-test legs", () => {
  const job = ci.jobs["rust-test"];
  const steps = (job?.steps ?? []).filter((s) => /\bclippy\b/.test(s.run ?? ""));

  it("has exactly one clippy step in rust-test", () => {
    expect(job, "rust-test job").toBeDefined();
    expect(steps).toHaveLength(1);
  });

  it("denies warnings across all targets on a pinned toolchain", () => {
    const run = steps[0]?.run ?? "";
    const pinned = run.match(/rustup toolchain install (\d+\.\d+\.\d+)\b[^\n]*--component clippy/);
    expect(pinned, "installs an exact x.y.z toolchain with the clippy component").not.toBeNull();
    expect(run).toContain(`cargo +${pinned?.[1]} clippy`);
    expect(run).toContain("--manifest-path src-tauri/Cargo.toml");
    expect(run).toContain("--all-targets");
    expect(run).toMatch(/--\s+-D warnings/);
    expect(steps[0]?.["continue-on-error"], "clippy must be able to fail the leg").toBeUndefined();
  });

  it("runs on the ubuntu and windows legs", () => {
    const os = job?.strategy?.matrix?.os ?? [];
    expect(os).toEqual(expect.arrayContaining(["ubuntu-latest", "windows-latest"]));
    // The only condition allowed is excluding macOS.
    const cond = steps[0]?.if;
    expect(cond === undefined || cond === "matrix.os != 'macos-latest'", String(cond)).toBe(true);
  });
});
