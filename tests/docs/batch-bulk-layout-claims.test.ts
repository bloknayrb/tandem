import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `derived-spec.md` 3.4 makes measured claims about where the batch and bulk
 * bars actually sit. This pins them against the source.
 *
 * The reason this file exists is that a claim about these two components was
 * wrong for a long time and nothing noticed. `HANDOFF-MANIFEST.md` — which
 * lives in the Claude Design project "Tandem Design System", NOT in this repo,
 * so nothing here could ever have contradicted it — carries an anti-pattern on
 * both rows reading "position absolute at rail bottom, never floats above the
 * rail's `overflow: hidden` track". Half of that is real: `.rail-full` in
 * `App.svelte` genuinely is `position: absolute` and `overflow: hidden`. The
 * false half is that it says anything about the BARS, which are in normal flow
 * near the TOP of a panel that is its own scroller. A cluster-3.4 canvas drawn
 * from that sentence would place both bars where neither is.
 *
 * (The first draft of this file over-corrected and called the whole sentence
 * fiction. That is recorded because it is the same failure in the other
 * direction: an unverified refutation is worth no more than the unverified
 * claim it attacks.)
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
    // Any `position:` here — not just a sticky one — means the split the doc
    // describes has changed. See the file header.
    expect(BULK).not.toMatch(/position:\s*\S/);
  });

  it("neither bar is absolutely positioned", () => {
    // The rail track above them IS absolute (`.rail-full` in `App.svelte`);
    // this pins only that the bars themselves are not, which is the half of
    // the manifest's anti-pattern that never matched.
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
    // Anchored on the aria-label, which is unique in this file. `role="list"`
    // alone is not: it occurs five times, and the first hit is a code comment
    // ~11k characters ahead of the bars, so matching it made this assertion
    // fail against correct code. That wrong turn is why this comment exists.
    const listAt = PANEL.indexOf('aria-label="Annotations"');
    expect(batchAt, "BatchPromoteBar is not rendered").toBeGreaterThan(-1);
    expect(bulkAt, "BulkActions is not rendered").toBeGreaterThan(-1);
    expect(listAt, "the annotation list is not rendered").toBeGreaterThan(-1);
    expect(batchAt, "promote must render before bulk").toBeLessThan(bulkAt);
    expect(bulkAt, "both bars must render before the list").toBeLessThan(listAt);
  });

  it("scrolls the panel itself — the bars' own scrollport is not a clipped track", () => {
    // The claim 3.4 rests on: the element the bars live in scrolls, so they
    // participate in its flow rather than floating over a separate track.
    // This does not (and must not) assert that nothing anywhere is
    // `overflow: hidden` — `.rail-full` in `App.svelte` is exactly that.
    expect(PANEL).toContain("overflow-y: auto");
    expect(PANEL).toContain("flex-direction: column");
    expect(PANEL, "the scroller must still carry the y-axis scroll fade").toContain(
      "tandem-scroll-fade-y",
    );
  });

  it("keeps 3.4's own wording in step with the above", () => {
    // Cheap, but it is the half that rots: the assertions above pin the code,
    // and this pins that the doc still says what the code does. Both claims
    // moved together on 2026-08-31 and should keep moving together.
    const from = SPEC.indexOf("### 3.4 Batch + bulk actions");
    const to = SPEC.indexOf("### 3.5 Margin column");
    // Checked before slicing: a missing END heading would leave `slice` happily
    // returning the file's whole tail, and a missing START heading returns a
    // one-character string, so a `.not.toBe("")` guard downstream catches
    // neither.
    expect(from, "3.4's heading is missing from derived-spec.md").toBeGreaterThan(-1);
    expect(to, "3.5's heading is missing, so 3.4 has no end bound").toBeGreaterThan(from);
    // Matched against whitespace-collapsed prose. The section is hard-wrapped
    // markdown, so any phrase long enough to be worth pinning is one reflow
    // away from straddling a newline — a raw match on the source text then
    // passes or fails on where the wrap happens to fall, which is not a claim
    // about anything. `does not exist yet` was already split when written.
    const prose = SPEC.slice(from, to).replace(/\s+/g, " ");
    expect(prose).toContain("position: sticky");
    expect(prose).toContain("overflow-y: auto");
    expect(prose).toMatch(/no height budget to reserve/i);
    expect(prose, "the retired exclusivity rule must stay retired").toMatch(
      /not mutually exclusive/i,
    );
    expect(prose, "the accent decision must stay recorded").toMatch(/ACCENT family/);
    expect(prose, "the accent decision must stay marked forward-looking, not as shipped").toMatch(
      /does not exist yet/i,
    );
    expect(prose, "the manifest must be named as a non-repo file").toMatch(/Tandem Design System/);
  });
});
