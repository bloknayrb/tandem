import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `derived-spec.md` 3.4 makes measured claims about where the batch and bulk
 * bars actually sit. This pins them against the source.
 *
 * The reason this file exists is that the claim it replaced was wrong for a
 * long time and nothing noticed. `HANDOFF-MANIFEST.md` told every reader that
 * both bars are "position absolute at rail bottom" over a rail track that is
 * `overflow: hidden`. None of those three things is true: they are in normal
 * flow near the TOP of the panel, the panel itself is the scroller, and
 * nothing is `overflow: hidden`. A cluster-3.4 canvas drawn from that sentence
 * would have been drawn against fiction, and the error is the kind that
 * survives review because it reads like a plausible layout.
 *
 * So the interesting assertion here is not "sticky is set" — it is the
 * INCONSISTENCY between the two bars, which is the actual open design
 * question 3.4 owes an answer to. If someone resolves it (by making both
 * sticky, or neither), this test SHOULD go red: that is the signal to update
 * 3.4 rather than leave the doc describing the old split.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

const BATCH = read("src/client/panels/BatchPromoteBar.svelte");
const BULK = read("src/client/panels/BulkActions.svelte");
const PANEL = read("src/client/panels/SidePanel.svelte");
const SPEC = read("docs/design-system-impl/derived-spec.md");

describe("derived-spec 3.4 describes the batch/bulk layout that ships", () => {
  it("BatchPromoteBar is sticky to the top", () => {
    expect(BATCH).toContain("position: sticky");
    expect(BATCH).toContain("top: 0");
  });

  it("BulkActions sets no position at all", () => {
    // A plain-flow bar. `position:` appearing here at all means the split the
    // doc describes has changed — see the file header.
    expect(BULK).not.toMatch(/position:\s*(sticky|absolute|fixed|relative)/);
  });

  it("neither bar is absolutely positioned at a rail bottom", () => {
    for (const [name, src] of [
      ["BatchPromoteBar", BATCH],
      ["BulkActions", BULK],
    ] as const) {
      expect(src, `${name} must not be absolutely positioned`).not.toMatch(/position:\s*absolute/);
    }
  });

  it("renders both bars ABOVE the annotation list, promote first", () => {
    const batchAt = PANEL.indexOf("<BatchPromoteBar");
    const bulkAt = PANEL.indexOf("<BulkActions");
    // Anchored on the aria-label, not on `role="list"` alone: the string
    // appears four times in this file (twice in prose/comments, once on the
    // resolved-annotations list), and the first hit is a code comment ~11k
    // characters ahead of the bars. Matching it made the assertion fail
    // against correct code, which is how this comment came to exist.
    const listAt = PANEL.indexOf('aria-label="Annotations"');
    expect(batchAt, "BatchPromoteBar is not rendered").toBeGreaterThan(-1);
    expect(bulkAt, "BulkActions is not rendered").toBeGreaterThan(-1);
    expect(listAt, "the annotation list is not rendered").toBeGreaterThan(-1);
    expect(batchAt, "promote must render before bulk").toBeLessThan(bulkAt);
    expect(bulkAt, "both bars must render before the list").toBeLessThan(listAt);
  });

  it("scrolls the whole panel rather than an inner overflow:hidden track", () => {
    expect(PANEL).toContain("overflow-y: auto");
    expect(PANEL).toContain("flex-direction: column");
  });

  it("keeps 3.4's own wording in step with the above", () => {
    // Cheap, but it is the half that rots: the assertions above pin the code,
    // and this pins that the doc still says what the code does. Both claims
    // moved together on 2026-08-31 and should keep moving together.
    const section = SPEC.slice(
      SPEC.indexOf("### 3.4 Batch + bulk actions"),
      SPEC.indexOf("### 3.5 Margin column"),
    );
    expect(section, "3.4 is missing from derived-spec.md").not.toBe("");
    expect(section).toContain("position: sticky");
    expect(section).toContain("overflow-y: auto");
    expect(section).toMatch(/no height budget to reserve/i);
    expect(section, "the retired exclusivity rule must stay retired").toMatch(
      /not mutually exclusive/i,
    );
    expect(section, "the accent decision must stay recorded").toMatch(/ACCENT family/);
  });
});
