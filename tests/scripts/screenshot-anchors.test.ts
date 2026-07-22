/**
 * `scripts/take-screenshots.mjs` anchors its demo annotations on exact
 * substrings of `sample/welcome.md`. When that prose is edited, `findRange`
 * returns null and the script's `if (range)` guard drops the annotation
 * SILENTLY — the screenshot just comes out missing a comment, with no error and
 * no failed step. Nobody notices until a README image looks wrong.
 *
 * So this test does what a human reviewer of a prose edit will not reliably do:
 * check that every anchor still exists in the file it points at.
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
const script = readFileSync(join(repoRoot, "scripts/take-screenshots.mjs"), "utf8");

/**
 * Anchors are declared as `const <something>Text = "..."`. Long enough to
 * exclude incidental short string constants; the count guard below catches the
 * case where a rename makes this stop matching.
 */
const anchors = [...script.matchAll(/const \w*Text\s*=\s*"([^"]{20,})"/g)].map((m) => m[1]);

describe("take-screenshots.mjs anchors resolve against sample/welcome.md", () => {
  it("finds the anchor declarations at all (guards the regex itself)", () => {
    // Without this, a rename to the `const ...Text` convention would empty the
    // list and every assertion below would vacuously pass — the same
    // silent-disarm this file exists to prevent.
    expect(anchors.length).toBeGreaterThanOrEqual(4);
  });

  it.each(anchors)("anchor is present: %s", (anchor) => {
    expect(welcome).toContain(anchor);
  });
});
