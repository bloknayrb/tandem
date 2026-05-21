import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tutorial-anchor gate for the design-system-impl umbrella branch.
 *
 * Every entry in src/server/mcp/tutorial-annotations.ts has a `targetText`
 * substring that must resolve unambiguously in sample/welcome.md. When the
 * welcome content drifts (a paragraph rephrased, a sentence rewritten) the
 * anchor silently breaks — `injectTutorialAnnotations` logs a console.error
 * and skips that annotation, leaving a quietly-broken tutorial.
 *
 * This gate reads both files at test time and asserts each anchor still
 * resolves (idx !== -1) AND is unique (idx === lastIndexOf). Sub-PRs that
 * touch sample/welcome.md OR the tutorial annotations array must either
 * preserve all anchors or update both files in lockstep.
 *
 * See docs/design-system-impl/tutorial-anchor-manifest.md for the frozen
 * snapshot of expected anchors + the surrounding-text fingerprint that lets
 * reviewers see at a glance what each annotation marks.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const TUTORIAL_SRC = readFileSync(
  join(ROOT, "src", "server", "mcp", "tutorial-annotations.ts"),
  "utf-8",
);
const WELCOME = readFileSync(join(ROOT, "sample", "welcome.md"), "utf-8");

/** Pull every `targetText: "..."` from the tutorial source. */
function extractAnchors(src: string): string[] {
  const out: string[] = [];
  const re = /targetText:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    // Unescape the captured string (handles \" \\ \u00xx etc).
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      out.push(m[1]);
    }
  }
  return out;
}

const anchors = extractAnchors(TUTORIAL_SRC);

describe("tutorial-anchor coverage", () => {
  it("extracts at least one anchor (parser sanity check)", () => {
    expect(anchors.length).toBeGreaterThan(0);
  });

  it.each(anchors.map((a) => [a]))("anchor %j resolves in sample/welcome.md", (anchor) => {
    expect(WELCOME.indexOf(anchor)).toBeGreaterThanOrEqual(0);
  });

  it.each(anchors.map((a) => [a]))("anchor %j is unique in sample/welcome.md", (anchor) => {
    expect(WELCOME.indexOf(anchor)).toBe(WELCOME.lastIndexOf(anchor));
  });
});
