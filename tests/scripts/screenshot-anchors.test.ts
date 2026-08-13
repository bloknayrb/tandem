/**
 * `scripts/screenshots/capture.spec.ts` anchors its demo annotations on exact
 * substrings of `sample/welcome.md`. A missing anchor now THROWS there rather
 * than dropping the annotation silently (the deleted `take-screenshots.mjs`
 * returned null from `findRange` and its `if (range)` guard swallowed it, so a
 * README image just came out missing a comment) — but that throw only fires
 * during a capture run, which is manual and rare.
 *
 * So this test does what a human reviewer of a prose edit will not reliably do:
 * check that every anchor still exists in the file it points at, at `npm test`
 * time, before anyone tries to capture.
 *
 * It is not a substitute for looking at the screenshots. It only proves the
 * annotations will attach — not that they land somewhere that reads well.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "../..");

const welcome = readFileSync(join(repoRoot, "sample/welcome.md"), "utf8");
const spec = readFileSync(join(repoRoot, "scripts/screenshots/capture.spec.ts"), "utf8");

/**
 * Anchors are declared as `const <something>Text = "..."`. The `Text` suffix is
 * the opt-in marker — the capture spec holds plenty of other long string
 * literals (chat turns, annotation bodies, seeded file contents) that are NOT
 * anchors and must not be asserted against welcome.md. Length floor excludes
 * incidental short constants; the count guard below catches a rename that makes
 * this stop matching.
 */
const anchors = [...spec.matchAll(/const \w*Text\s*=\s*"([^"]{20,})"/g)].map((m) => m[1]);

describe("capture.spec.ts anchors resolve against sample/welcome.md", () => {
  it("finds the anchor declarations at all (guards the regex itself)", () => {
    // Without this, a rename away from the `const ...Text` convention would
    // empty the list and every assertion below would vacuously pass — the same
    // silent-disarm this file exists to prevent.
    expect(anchors.length).toBeGreaterThanOrEqual(4);
  });

  it.each(anchors)("anchor is present: %s", (anchor) => {
    expect(welcome).toContain(anchor);
  });
});
