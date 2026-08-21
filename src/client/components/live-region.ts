/**
 * Visually-hidden recipe for the persistent announcers of #1431.
 *
 * An inline `style` string, not a CSS class, for two reasons:
 *   1. It is the recipe already in the tree at `panels/SidePanel.svelte`'s
 *      pending-count announcer, verbatim — one copy rather than two.
 *   2. It never crosses the lightningcss pipeline, so there is no chance of a
 *      transform collapsing the clip and leaving a 1px region that is
 *      technically visible (or a zero-size one the a11y tree drops).
 *
 * `position: absolute` is load-bearing beyond invisibility: an absolutely
 * positioned child of a flex container is NOT a flex item, so the announcer
 * costs nothing in the gapped flex columns it mounts into (`.iw-dialog`,
 * `.source-view`). `display: none` / `visibility: hidden` / zero-size-without-
 * clip would each take the region back OUT of the accessibility tree, which is
 * the exact bug this file exists to fix.
 */
export const SR_ONLY_STYLE =
  "position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0);";
