import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The reaper build script forwards `--target` to cargo, but only after the
// value passes the SUPPORTED_TRIPLES allowlist. This smoke test asserts the
// security-relevant rejection boundary: an unknown triple must be rejected
// BEFORE cargo is ever invoked (so a stray value can't reach the build), with
// a non-zero exit and a clear message. It runs the real script in a child
// process and never touches cargo (rejection precedes it), so it's fast and
// deterministic.
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "build-reaper.mjs",
);

describe("scripts/build-reaper.mjs — target allowlist", () => {
  it("rejects an unknown --target before invoking cargo", () => {
    let threw = false;
    let status: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, "--target", "bogus-not-a-triple"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      threw = true;
      const e = err as { status?: number | null; stderr?: string | Buffer };
      status = e.status ?? null;
      stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    }

    expect(threw).toBe(true);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unsupported target triple");
  });
});
