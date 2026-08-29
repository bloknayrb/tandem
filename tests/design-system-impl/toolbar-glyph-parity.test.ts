import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The "hide the formatting bar" affordance exists in two places — on the bar
 * itself (`FormattingBar.svelte`'s `.fmtbar-hide`) and in the selection popup
 * (`Toolbar.svelte`'s `.popup-swap-btn`, whose `formattingBarVisible` branch is
 * the hide state). They do the same thing from different places, so they must
 * draw the same glyph.
 *
 * Both files state that requirement in a comment ("keep them identical", "must
 * stay identical") and nothing enforced it. A one-sided redraw is invisible to
 * every other check in the repo: the glyphs live inside `aria-hidden` SVGs so
 * no accessible name moves, the buttons keep their testids so no E2E selector
 * breaks, and the two files are far enough apart that a reviewer sees one
 * without the other. The failure mode is quiet visual drift between two
 * controls a user reads as one.
 *
 * Compares the `d` attributes as an ordered list rather than the SVG markup:
 * the two elements legitimately differ in sizing (the popup's sets explicit
 * width/height, the bar's takes them from CSS) and in surrounding whitespace.
 * The path data is the part that must match.
 */

const BAR = "src/client/shell/FormattingBar.svelte";
const POPUP = "src/client/editor/toolbar/Toolbar.svelte";

/** Every `d="…"` inside the first `<svg>` that follows `anchor` in `file`. */
function glyphAfter(file: string, anchor: string): string[] {
  const src = readFileSync(file, "utf-8");
  const at = src.indexOf(anchor);
  expect(at, `${file}: anchor ${JSON.stringify(anchor)} not found`).toBeGreaterThan(-1);
  const svgStart = src.indexOf("<svg", at);
  const svgEnd = src.indexOf("</svg>", svgStart);
  expect(svgStart, `${file}: no <svg> after ${anchor}`).toBeGreaterThan(-1);
  expect(svgEnd, `${file}: unterminated <svg> after ${anchor}`).toBeGreaterThan(svgStart);
  return [...src.slice(svgStart, svgEnd).matchAll(/\bd="([^"]+)"/g)].map((m) => m[1].trim());
}

describe("the two hide-formatting-bar affordances draw one glyph", () => {
  it("FormattingBar's hide button and the popup's swap button share path data", () => {
    const bar = glyphAfter(BAR, 'data-testid="formatbar-hide-btn"');
    const popup = glyphAfter(POPUP, "{#if formattingBarVisible}");

    // Fail closed: an anchor that stopped matching, or an SVG that lost its
    // paths, must red rather than compare two empty lists as equal.
    expect(bar.length, `${BAR}: extracted no path data — the scan is broken`).toBeGreaterThan(0);
    expect(popup.length, `${POPUP}: extracted no path data — the scan is broken`).toBeGreaterThan(
      0,
    );

    expect(
      popup,
      "the popup's hide glyph and the formatting bar's hide glyph have diverged. " +
        "They are the same affordance reached from two places and a user reads " +
        "them as one control — redraw both or neither",
    ).toEqual(bar);
  });
});
