<script lang="ts">
import type { Annotation } from "../../shared/types.js";
import { agentTintColor } from "../utils/agent-color.js";

interface Props {
  side: "left" | "right";
  onActivate: () => void;
  /** Whether the parent rail is collapsed. Drives aria-expanded; the peek
      layer is only displayed (by App.svelte) while the rail is collapsed. */
  collapsed: boolean;
  /** Which contextual preview to render in the sliver. */
  kind: "outline" | "annotations";
  /** Right-rail only: annotations to render as dots (presentation only). */
  annotations?: Annotation[];
}

const { side, onActivate, collapsed, kind, annotations = [] }: Props = $props();

// Left rail is locked to the outline; right rail hosts annotations + chat.
// The collapsed-state label names the panel so the user knows what they're
// bringing back. "Annotations" for the right rail matches the default tab.
const label = $derived(side === "left" ? "Outline" : "Annotations");

// Type→token dot class for the right-rail preview. Maps the PRODUCTION
// annotation taxonomy (not the bundle's mock `suggest` type, which never
// exists at runtime): a Claude suggestion is a `comment` carrying
// `suggestedText`; highlights collapse to a single yellow stand-in; Word
// imports read as a distinct neutral dot so they aren't mistaken for the
// user's own marks. Presentation only — never reaches Claude (ADR-027 is a
// server→Claude boundary; these dots are DOM-only).
// Type-first, then author: a suggestion (Claude-only `comment` carrying
// `suggestedText`) must outrank the author check so it reads as "suggest", not
// "claude". The data model permits but the taxonomy forbids a user-authored
// suggestion (server validation is the real guard); were one to leak through,
// "suggest" is still the honest label for the data.
function dotClass(a: Annotation): string {
  if (a.type === "highlight") return "hl";
  if (a.type === "comment" && a.suggestedText != null) return "suggest";
  if (a.author === "claude") return "claude";
  if (a.author === "import") return "import";
  return "user";
}
</script>

<!-- A sliver of the collapsed panel pokes out from the window edge so the
     user can see where to click to bring it back. Matches the rail's
     surface-muted background, inner-corner radius, and top/bottom insets so
     it visually reads as "the same card, mostly tucked away." The sliver
     previews its panel's contents: outline tick-marks (left) or annotation
     dots (right). -->
<!-- tabindex="-1": Alt+Shift+Arrow is the keyboard equivalent; the strip
     stays out of the Tab sequence to avoid cluttering the focus order. Kept
     at -1 (NOT collapsed?0:-1) so the #859 inert-restoration-focus fix below
     holds — a Tab-reachable strip with no focus ring would be the inverse of
     that bug. No onkeydown: this is a native button, so Enter/Space
     synthesize a click natively → onclick covers keyboard activation. -->
<!-- display:none when the rail is expanded so the peek doesn't overlay the
     full panel's inside edge. Always rendered (instance persists) — the
     snap equivalent of the bundle's opacity:0-when-expanded. -->
<button
  class="peek-strip peek-strip-{side}"
  data-testid={`peek-strip-${side}`}
  type="button"
  tabindex="-1"
  aria-label={side === "left" ? "Show left panel" : "Show right panel"}
  aria-expanded={!collapsed}
  style={collapsed ? "" : "display: none;"}
  onclick={onActivate}
>
  <span class="peek-chevron" aria-hidden="true">
    {side === "left" ? "›" : "‹"}
  </span>
  <!-- Contextual preview. Decorative (aria-hidden); the button's aria-label
       is the accessible name. -->
  <div class="peek-content" aria-hidden="true">
    {#if kind === "outline"}
      <span class="peek-tick h1"></span>
      <span class="peek-tick h2"></span>
      <span class="peek-tick h2"></span>
      <span class="peek-tick h3"></span>
      <span class="peek-tick h2"></span>
    {:else}
      {#each annotations as a (a.id)}
        {@const cls = dotClass(a)}
        {@const tint = agentTintColor(a.agentIdentity)}
        <!-- #1123 M4: per-agent dot color for a plain claude comment carrying an
             agentIdentity; absent (dark / suggest / highlight) ⇒ no inline style
             ⇒ the CSS class color renders unchanged. -->
        <span
          class="peek-dot {cls}"
          data-testid="peek-dot-{a.id}"
          style={cls === "claude" && tint ? `background: ${tint};` : undefined}
        ></span>
      {/each}
    {/if}
  </div>
  <!-- Rotated panel name, revealed on hover once the strip widens (not on
       focus, per #859 — restoration focus must stay visually inert).
       Decorative (the button's aria-label is the accessible name); its
       surface-muted background masks the content it sits over. -->
  <span class="peek-label" aria-hidden="true">{label}</span>
</button>

<style>
  /* The peek button is the collapsed rail's content layer. It lives INSIDE
     the width-controlled `.rail-shell` (App.svelte), which owns the chrome
     (surface-muted bg, border, inner radius, shadow) and the hover-grow to
     28px. So the button itself is transparent and simply fills the shell's
     inside edge — the chevron + preview + label sit right next to the editor.
     At rest the shell clips it to 14px via overflow:hidden; on shell hover
     the shell widens to 28px and the full button shows. */
  .peek-strip {
    position: absolute;
    inset-block: 0;
    width: 28px;
    padding: 16px 0 18px;
    border: none;
    background: transparent;
    color: var(--tandem-fg-faint);
    font: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  /* Anchored to the rail's INSIDE edge (next to the editor): the left rail's
     inside edge is its right side; the right rail's is its left side. */
  .peek-strip-left {
    right: 0;
  }
  .peek-strip-right {
    left: 0;
  }
  .peek-chevron {
    font-size: var(--tandem-text-sm);
    line-height: 1;
    opacity: 0.7;
    transition: opacity 160ms ease;
    flex-shrink: 0;
  }
  /* Contextual preview column: outline ticks or annotation dots, stacked. */
  .peek-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 0 3px;
    overflow: hidden;
  }
  .peek-tick {
    height: 2px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-border-strong);
    opacity: 0.7;
    transition: opacity 160ms ease;
  }
  .peek-tick.h1 {
    width: 8px;
  }
  .peek-tick.h2 {
    width: 6px;
  }
  .peek-tick.h3 {
    width: 4px;
  }
  .peek-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--tandem-r-circle, 50%);
    opacity: 0.85;
    flex-shrink: 0;
    transition: opacity 160ms ease, transform 160ms ease;
  }
  .peek-dot.user {
    background: var(--tandem-author-user);
  }
  .peek-dot.claude {
    background: var(--tandem-author-claude);
  }
  .peek-dot.suggest {
    background: var(--tandem-suggestion);
  }
  .peek-dot.hl {
    background: var(--tandem-highlight-yellow);
  }
  /* Word-imported reviewer comments: neutral, distinct from the user's own
     blue and Claude's orange. */
  .peek-dot.import {
    background: var(--tandem-fg-muted);
  }
  /* Rotated vertical panel name, centered over the chevron. Hidden at rest;
     fades in once the strip widens on hover. Its surface-muted background
     masks the preview underneath so the two don't visually clash. Scoped to
     :hover only (never :focus-visible) per #859 — see the focus comment below. */
  .peek-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-90deg);
    font-family: var(--tandem-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tandem-fg-muted);
    background: var(--tandem-surface-muted);
    padding: 2px 6px;
    border-radius: var(--tandem-r-1);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms ease 60ms;
  }
  /* Width-grow on hover lives on the parent `.rail-shell` (App.svelte) so the
     widened button isn't clipped by the shell's overflow:hidden. Here we only
     brighten the preview atoms when the (shell-)hovered button shows. */
  .peek-strip:hover .peek-chevron {
    opacity: 1;
  }
  .peek-strip:hover .peek-tick {
    opacity: 1;
  }
  .peek-strip:hover .peek-dot {
    opacity: 1;
    transform: scale(1.05);
  }
  .peek-strip:hover .peek-label {
    opacity: 1;
  }
  /* When the strip widens on hover the label fades in over the preview; dim
     the preview so the two don't clash. */
  .peek-strip:hover .peek-content {
    opacity: 0.25;
    transition: opacity 140ms ease;
  }
  /* tabindex="-1": never reachable via Tab. The only focus paths are the
     keyboard-toggle restoration helper (focusToggleTarget, which focuses the
     strip purely to preserve tab position after the panel collapses) and a
     mouse click. The restoration focus follows a keydown, so :focus-visible
     would match and draw a lingering accent ring — plus the width-expand and
     elevation bump it once shared with :hover would make the strip silently
     widen (#859). Restoration focus must be visually inert, so the hover
     affordances (width, elevation, chevron + label reveal) are scoped to
     :hover only and no focus ring is drawn. */
  .peek-strip:focus-visible {
    outline: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .peek-strip,
    .peek-chevron,
    .peek-tick,
    .peek-dot,
    .peek-label {
      transition: none;
    }
  }
</style>
