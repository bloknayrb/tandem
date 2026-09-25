import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCX_ENABLED } from "../../src/shared/constants.js";

/**
 * `.docx` ships dark (ADR-053), and CI's E2E backend is the built bundle, where the
 * define turns `.docx` off and no env var can turn it back on. So the E2E tests that
 * need a real `.docx` import are skipped on `!DOCX_ENABLED`.
 *
 * A skip reads exactly like a pass in a green run, so the set is pinned here: adding a
 * skip is a visible edit to this list rather than a quiet way to make a failing spec go
 * away, and the re-enable checklist in ADR-053 points at this file to find what to
 * un-skip. Each skip is pinned with its scope, because `margin-view` skips one test
 * and must not quietly become a file-level skip of the whole spec: a line at column 0
 * skips the file, an indented one sits inside a test body.
 */
const EXPECTED_SKIPS: Record<string, string[]> = {
  "batch-promote.spec.ts": ["file"],
  "batch-promote-width.spec.ts": ["file"],
  "margin-view.spec.ts": ["test"],
};

const E2E_DIR = join(import.meta.dirname, "..", "e2e");
const BACKSLASH = String.fromCharCode(92);
// Any spelling of a skip or fixme keyed on the flag, so a respelled one can't slip past.
const SKIP = /^([ \t]*)test\.(?:skip|fixme)\(\s*!\s*DOCX_ENABLED\b/gm;

function skipCounts(): Record<string, string[]> {
  const counts: Record<string, string[]> = {};
  for (const entry of readdirSync(E2E_DIR, { recursive: true, encoding: "utf-8" })) {
    if (!entry.endsWith(".spec.ts")) continue;
    const text = readFileSync(join(E2E_DIR, entry), "utf-8");
    const scopes = [...text.matchAll(SKIP)].map((m) => (m[1] === "" ? "file" : "test"));
    if (scopes.length > 0) counts[entry.replaceAll(BACKSLASH, "/")] = scopes;
  }
  return counts;
}

describe("E2E .docx skips while .docx ships dark (ADR-053)", () => {
  it("the skipped set is exactly the pinned list", () => {
    const counts = skipCounts();
    // Positive anchor: the scan found the directory and at least one skip, so an
    // empty result can't satisfy the equality below by accident.
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    expect(counts).toEqual(EXPECTED_SKIPS);
  });

  it("is still needed: .docx is off in this build", () => {
    // Fails on the flip, which is the prompt to un-skip the list and delete this file.
    expect(DOCX_ENABLED).toBe(false);
  });
});
