import { describe, expect, it } from "vitest";

import { formatLogLine, SUPPRESSED_PATTERNS } from "../../src/server/log-filter.js";

/**
 * #1823 item 1. The production (Tauri sidecar) console filter used to write
 * `args.map(String).join(" ")`, so every `%s`/`%d` placeholder reached the log
 * literally and every Error was truncated to `name: message`. These pin the
 * formatting half AND the narrow-probe half that keeps suppression from
 * widening.
 */
describe("formatLogLine (#1823)", () => {
  it("applies util.format placeholders instead of joining stringified args", () => {
    expect(formatLogLine(["x %s", "y"])).toBe("x y");
    expect(formatLogLine(["doc %s failed after %d ms", "abc", 12])).toBe(
      "doc abc failed after 12 ms",
    );
  });

  it("keeps an Error's full stack, which String(err) truncated away", () => {
    const err = new Error("boom");
    const line = formatLogLine(["save failed:", err]);
    expect(line).toContain("save failed:");
    expect(err.stack).toBeDefined();
    expect(line).toContain(err.stack as string);
    // The old shape: `String(err)` is "Error: boom" with no frames.
    expect(line).not.toBe(`save failed: ${String(err)}`);
  });

  it("suppresses the known dependency noise", () => {
    expect(formatLogLine(["[mammoth] unrecognised style"])).toBeNull();
    expect(formatLogLine(["Invalid access: yjs"])).toBeNull();
    expect(formatLogLine(["  add yjs type"])).toBeNull();
    // Sanity, NOT discriminating — a format-then-test rewrite drops this too.
    expect(formatLogLine(["[mammoth] %s", "x"])).toBeNull();
  });

  it("does NOT suppress a fatal whose STACK merely contains a suppressed phrase", () => {
    // The discriminating case. `/Invalid access/i` is unanchored, and
    // `util.format(err)` emits the stack — so a filter that formatted BEFORE
    // testing would silently swallow this unrelated fatal in the sidecar build.
    // The probe is `String(err)` ("Error: boom"), which matches nothing.
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (/x/Invalid access/y.ts:1:1)";
    const line = formatLogLine(["fatal:", err]);
    expect(line).not.toBeNull();
    expect(line).toContain("Invalid access");
  });

  it("leaves an ordinary single-argument line untouched", () => {
    expect(formatLogLine(["[Tandem] listening on 3479"])).toBe("[Tandem] listening on 3479");
  });

  it("exports the pattern set the sidecar branch uses", () => {
    expect(SUPPRESSED_PATTERNS).toHaveLength(3);
  });
});
