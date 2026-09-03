/**
 * Adaptive per-tab width floor (`uniformTabWidth: false`). Pure DOM
 * measurement over a live `.tab-flip` wrapper — shared by two callers that
 * need the SAME number at two different times:
 *   - DocumentTabs' post-render `$effect`, which floors every open tab
 *     (writes the result as each wrapper's inline `min-width`).
 *   - cardMotion's `tabEnter`, which needs it synchronously at transition
 *     SETUP time (during Svelte's render/DOM-patch pass, strictly before
 *     `$effect`s flush) for a tab the effect hasn't floored yet — see the
 *     `tabEnter` doc comment in `cardMotion.ts` for why.
 *
 * 142px is TabItem's chrome (indicator + gaps + close + padding + borders,
 * ~60px) plus ~80px of filename, the least that still reads as a name — see
 * the `.tab-flip` CSS comment in DocumentTabs.svelte for the full rationale
 * and the measured numbers behind it.
 */
export const TAB_FLOOR_PX = 142;

/**
 * Measures a single `.tab-flip` wrapper's adaptive floor: the smaller of
 * (its own chrome + natural filename width) and `TAB_FLOOR_PX`. Returns
 * `TAB_FLOOR_PX` when the wrapper's expected children aren't found (e.g. a
 * layout-less test DOM, or a tab structure this function doesn't recognize)
 * — uniform-when-unmeasurable beats silently-inert.
 */
export function measureTabFloor(wrapper: HTMLElement): number {
  const pill = wrapper.querySelector<HTMLElement>('[role="tab"]');
  const name = wrapper.querySelector<HTMLElement>('[data-testid^="tab-name-"]');
  // Renaming swaps the name span for an input whose own 80px minimum needs
  // the full floor; bail to it rather than measuring a node that isn't there.
  if (!pill || !name) return TAB_FLOOR_PX;

  // Chrome is NOT a constant and must not be derived as `pill − name`: a
  // floored tab carries slack, which that subtraction would count as chrome.
  // (Until #1736 that slack sat after the last child, parked there by
  // `flex-start`; it now lands in the close button's auto margin instead. The
  // conclusion is unchanged — the slack is still not chrome.) Sum the real
  // boxes — this also self-corrects for the read-only badge and its gap
  // (~29px together; the badge alone is ~23px and `flex-shrink: 0`) and for
  // the 2px border delta between an active and an inactive pill.
  const cs = getComputedStyle(pill);
  const kids = Array.from(pill.children).filter((k): k is HTMLElement => k instanceof HTMLElement);
  let chrome =
    parseFloat(cs.paddingLeft) +
    parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) +
    parseFloat(cs.borderRightWidth) +
    Math.max(0, kids.length - 1) * (parseFloat(cs.columnGap) || 0);
  for (const k of kids) {
    if (k !== name) chrome += k.getBoundingClientRect().width;
  }

  // `scrollWidth` is integer-rounded, so a name that exactly fits can still
  // pick up an ellipsis; +1 buys that back. Read the cap off the span itself
  // rather than restating TabItem's 240px literal here.
  //
  // THIS READ IS THE WHOLE REASON THE NAME SPAN MAY NOT GROW (#1736), and it
  // is the canonical statement of that rule — TabItem points here rather than
  // restating it. `scrollWidth` is `max(scrolling area, padding box)`, so it
  // means "the filename's width" only while the span is shrink-wrapped.
  //
  // Grow the span and it reports the BOX instead, which makes this function
  // measure its own input. On the first pass every wrapper still carries only
  // the base `.tab-flip { min-width: TAB_FLOOR_PX }`, so a grown span reports
  // whatever is left of that wrapper (~80px on a short name, not the floor
  // itself) — and `chrome` above is BY CONSTRUCTION everything in the pill
  // except the name, so `chrome + nameNatural` just reconstructs the wrapper's
  // own width and the `Math.min` below clamps it to TAB_FLOOR_PX. That is
  // written back as the tab's inline floor, and the next pass reconstructs it
  // again. Adaptive mode silently becomes uniform mode — no flicker, no error,
  // every tab simply the same width.
  //
  // Whatever absorbs slack inside the pill therefore must not be this span;
  // TabItem uses an auto margin on the close button, which resolves after flex
  // layout and is invisible to this measurement.
  const cap = parseFloat(getComputedStyle(name).maxWidth) || Number.POSITIVE_INFINITY;
  const nameNatural = Math.min(name.scrollWidth + 1, cap);
  const floor = Math.min(chrome + nameNatural, TAB_FLOOR_PX);
  // A layout-less DOM (happy-dom, which the unit tests run under) returns ""
  // from getComputedStyle for every length, so `chrome` is NaN and the write
  // below would emit "NaNpx" — an invalid declaration the browser drops on
  // the floor, leaving the tab silently unfloored. Fall back to the full
  // floor: uniform-when-unmeasurable beats silently-inert.
  return Number.isFinite(floor) ? floor : TAB_FLOOR_PX;
}
