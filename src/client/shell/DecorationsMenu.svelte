<script lang="ts">
import "../editor/toolbar/toolbar-chrome.css";
import { clickOutside } from "../actions/clickOutside.svelte";
import { ESCAPE_OWNER_ATTR } from "../utils/escape-owner";
import { focusMenuEntryPoint, handleMenuArrowKeys } from "../utils/menuKeys";

interface Props {
  showAuthorship: boolean;
  showComments: boolean;
  showHighlights: boolean;
  showNotes: boolean;
  /** Transient master overlay — suppresses all decoration rendering. */
  decorationsMuted: boolean;
  /**
   * Persist a settings partial. Per-type rows include `decorationsMuted: false`
   * in the same partial (one call) to auto-unmute; the eye toggles mute alone.
   */
  onUpdate: (partial: {
    showAuthorship?: boolean;
    showComments?: boolean;
    showHighlights?: boolean;
    showNotes?: boolean;
    decorationsMuted?: boolean;
  }) => void;
  /** Open Settings → Appearance (the canonical home for these toggles). */
  onOpenSettings?: () => void;
}

let {
  showAuthorship,
  showComments,
  showHighlights,
  showNotes,
  decorationsMuted,
  onUpdate,
  onOpenSettings,
}: Props = $props();

let menuOpen = $state(false);
let caretBtn = $state<HTMLButtonElement | null>(null);
let menuEl = $state<HTMLDivElement | null>(null);

// The caret button is a sibling of the dropdown, so focus has to be moved into
// the menu explicitly or arrow keys never reach its handler.
$effect(() => {
  if (menuOpen) focusMenuEntryPoint(menuEl);
});

function toggleMute() {
  onUpdate({ decorationsMuted: !decorationsMuted });
}

// Auto-unmute in ONE partial so the decoration + authorship effects fire once,
// avoiding a transient still-muted-with-new-value mid-state.
function toggleRow(
  field: "showAuthorship" | "showComments" | "showHighlights" | "showNotes",
  current: boolean,
) {
  onUpdate({ [field]: !current, ...(decorationsMuted ? { decorationsMuted: false } : {}) });
}

// Single close path so focus never strands on <body> when the focused menu item
// unmounts. Guarded: `clickOutside` fires on mousedown, i.e. before the browser
// moves focus itself, so restoring unconditionally would override wherever the
// user just clicked. Restore only when focus is still inside the menu (or has
// already been lost).
function closeMenu() {
  const ours =
    (!!menuEl && menuEl.contains(document.activeElement)) ||
    document.activeElement === document.body ||
    document.activeElement === null;
  menuOpen = false;
  if (ours) caretBtn?.focus();
}

function handleKey(e: KeyboardEvent) {
  if (handleMenuArrowKeys(e)) return;
  if (e.key === "Escape" && menuOpen) {
    e.stopPropagation();
    closeMenu();
  }
}

function chooseSettings() {
  onOpenSettings?.();
  closeMenu();
}
</script>

<!-- Both split halves AND the dropdown live inside one clickOutside node:
     clickOutside uses node.contains(), so a separate wrapper would treat a
     click on the eye/caret as "outside" and instantly re-close. NOT portaled.
     The split carries its OWN raised chrome (see `.split` in the styles below);
     it used to render flat to avoid a pill inside the FormattingBar's pill, and
     that trade was reversed deliberately — the rationale is with the rule. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="split menu-wrap"
  data-testid="decorations-menu"
  data-tauri-drag-region="false"
  {...(menuOpen ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
  use:clickOutside={closeMenu}
  onkeydown={handleKey}
>
  <button
    type="button"
    class="ib tandem-toolbar-ctl half-main"
    class:on={!decorationsMuted}
    data-testid="decorations-mute-toggle"
    aria-pressed={!decorationsMuted}
    title={decorationsMuted ? "Restore decorations" : "Mute decorations"}
    aria-label={decorationsMuted ? "Restore decorations" : "Mute decorations"}
    onclick={toggleMute}
  >
    {#if decorationsMuted}
      <!-- Crossed-out eye: the button is RAISED (unpressed) in this state, so
           the glyph has to carry the "hidden" meaning on its own — a plain eye
           on an unpressed button reads as "decorations are on". -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a15.6 15.6 0 0 1-2.6 3.3" />
        <path d="M6.6 6.6A15.4 15.4 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 3.4-.6" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="M3 3l18 18" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    {/if}
  </button>
  <span class="split-div" aria-hidden="true"></span>
  <button
    bind:this={caretBtn}
    type="button"
    class="ib tandem-toolbar-ctl half-caret"
    data-testid="decorations-menu-caret"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    title="Decoration options"
    aria-label="Decoration options"
    onclick={() => (menuOpen = !menuOpen)}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>

  {#if menuOpen}
    <div bind:this={menuEl} class="menu" role="menu" aria-label="Decorations">
      <div class="menu-head">Decorations</div>
      <p class="menu-help">
        Inline editor overlays — author colors, comment, highlight, and note
        marks. Toggle a type to hide its marks in the document; side-panel cards
        stay.
      </p>

      <button
        type="button"
        class="mi"
        class:on={showAuthorship}
        data-testid="decorations-row-authorship"
        role="menuitemcheckbox"
        aria-checked={showAuthorship}
        onclick={() => toggleRow("showAuthorship", showAuthorship)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9.5" cy="12" r="5" fill="var(--tandem-author-user)" />
            <circle cx="14.5" cy="12" r="5" fill="var(--tandem-author-claude)" />
          </svg>
        </span>
        <span class="mi-label">Authorship colors</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showComments}
        data-testid="decorations-row-comments"
        role="menuitemcheckbox"
        aria-checked={showComments}
        onclick={() => toggleRow("showComments", showComments)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l1.6-5A8.5 8.5 0 1 1 21 11.5z" /></svg>
        </span>
        <span class="mi-label">Comments</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showHighlights}
        data-testid="decorations-row-highlights"
        role="menuitemcheckbox"
        aria-checked={showHighlights}
        onclick={() => toggleRow("showHighlights", showHighlights)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="6" rx="2" fill="currentColor" opacity="0.25" stroke="none" /><path d="M4 6h16M4 18h11" /></svg>
        </span>
        <span class="mi-label">Highlights</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showNotes}
        data-testid="decorations-row-notes"
        role="menuitemcheckbox"
        aria-checked={showNotes}
        onclick={() => toggleRow("showNotes", showNotes)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M8 13h7M8 17h4" /></svg>
        </span>
        <span class="mi-label">Notes <span class="mi-tag">· private</span></span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      {#if onOpenSettings}
        <div class="menu-div" role="separator"></div>
        <button
          type="button"
          class="mi link"
          data-testid="decorations-settings-link"
          role="menuitem"
          onclick={chooseSettings}
        >
          <span>Appearance settings…</span>
          <kbd>Ctrl+,</kbd>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Split button: eye (mute/restore all) + caret (open options).
     `1.11-titlebar-decorations.html:55,78-82` gives it its own container
     (`.fpill` supplies surface + border + radius + shadow; `.fpill.split`
     overrides only `gap: 0; padding: 2px`, with 20px halves inside), so the
     pill silhouette exists at REST — not only when the eye is on. That is the
     point of the treatment: this is one compound control, and it has to look
     like one whether decorations are on or off.

     RAISED, not sunk. The control is a physical button that segments press
     INTO — not a recessed tray holding two flat glyphs. That is what makes the
     three states legible without a legend: the eye is pressed while
     decorations are on and raised (with a crossed-out glyph) while they are
     muted; the caret is raised except while it is held or its menu is open.
     A sunk container cannot express "pressed" at all, because there is nothing
     for a segment to press into.

     The press is NEUTRAL — sunk fill plus an inset shadow, no accent. In this
     bar the accent marks formatting actively applied to the selection, so
     tinting a persistent view toggle with it made the control read as a
     category rather than as a pressed key.

     This IS a pill inside the FormattingBar's pill, which earlier revisions of
     this file avoided on purpose. Accepted deliberately: the shadow is
     `--tandem-shadow-1` (0 1px 2px) rather than the floating-pill
     `--tandem-shadow-2` (0 8px 24px), so it reads as a raised key on a surface
     rather than as a second card floating over the document.

     KNOWN WEAKNESS in dark, unresolved. `--tandem-shadow-1` is defined once in
     `index.html` with no `[data-theme="dark"]` override, and 0.08-alpha black
     over the dark surface is close to invisible — the same reasoning that gave
     `--tandem-shadow-inset` its dark override. So in dark the container's RAISE
     is carried by the 1px border alone. Pressed-vs-raised still reads (the sunk
     fill and the dark inset both survive); what is weaker is the split standing
     off the bar. Not fixed here because `--tandem-shadow-1` reaches seven
     surfaces including the title bar and tab strip, so giving it a dark value
     is a design decision well outside this control. The E2E assertion only
     checks the shadow is not `none`, so it passes in dark and cannot catch
     this.

     The 2px padding and the halves' 20px height are load-bearing together:
     20 + 2*2 padding + 2*1 border = the bar's 26px. Changing one without the
     others makes this control the odd height out in a bar where everything
     else is exactly 26px. */
  .split {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 2px;
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
    border-radius: var(--tandem-r-pill);
    box-shadow: var(--tandem-shadow-1);
  }

  .menu-wrap {
    position: relative;
  }

  /* Resting metrics come from .tandem-toolbar-ctl (toolbar-chrome.css). The
     split halves below re-declare HEIGHT, padding and radius on purpose — they
     are a mated pair, not two independent controls, and the 20px height is the
     load-bearing one (see .split's arithmetic). `.half-main` deliberately does
     NOT re-declare `min-width`, so it keeps the shared 26px. Two further deltas are
     deliberate and inert today: `gap` converged 5px -> 4px and `font: inherit`
     became the shared type ramp, both invisible while each half holds a single
     icon child. */
  .ib {
    transition: background 120ms, color 120ms, box-shadow 120ms;
  }
  /* The icon button's hover/active tint fades only for polish; the `.on` state
     still reads from the final colours, so reduced motion drops the fade. */
  :global(body.tandem-reduce-motion) .ib {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ib {
      transition: none;
    }
  }
  /* Hover must NOT look pressed — the halves sit on a raised surface, so a
     sunk fill here would read as a click that already happened. A light tint
     keeps the raised read while still acknowledging the pointer. */
  .ib:hover {
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
  }
  .ib:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .ib svg {
    width: 16px;
    height: 16px;
    display: block;
  }

  /* PRESSED. There is deliberately no accent here (see .split's header), so
     the press is carried by the sunk fill plus the inset. Unlike ToolbarButton
     — where hover and active declare the identical fill, making the inset the
     ONLY difference — hover here is a lighter `--tandem-surface-muted` (see
     `.ib:hover` above). So dropping the inset would still leave the states
     distinguishable, just a shade apart rather than reading as PRESSED.
     Paired with the raised container it gives the control three states.

     `--tandem-shadow-inset` is shared with every other toggle that used to
     wear the accent (ToolbarButton, .fmtbar-source, the two Find & Replace
     toggles) — it carries a dark-theme override a literal here would not. */
  .half-main.on,
  .half-main.on:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    box-shadow: var(--tandem-shadow-inset);
  }
  /* The caret presses only transiently — while held, and for as long as its
     menu is open. `aria-expanded` is the menu-open source of truth already
     bound in the markup, so this needs no extra state. */
  .half-caret:active,
  .half-caret[aria-expanded="true"],
  .half-caret[aria-expanded="true"]:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    box-shadow: var(--tandem-shadow-inset);
  }
  .half-main:active {
    box-shadow: var(--tandem-shadow-inset);
  }
  /* Forced colors suppresses `box-shadow` outright and overrides
     `background-color`, so BOTH of the pressed signals above are gone there
     while the resting border is transparent. A forced border is the only
     channel left. `.fmtbar-source.on` and the two Find & Replace toggles
     already set `border-color`, so this keeps the new idiom legible in the one
     place it otherwise would not be. */
  @media (forced-colors: active) {
    .half-main.on,
    .half-caret:active,
    .half-caret[aria-expanded="true"] {
      border-color: Highlight;
    }
  }

  /* The two halves form ONE pill: outer corners round, inner corners SQUARE.
     They were r-2 (4px) on the inside, which rounded both sides of the 1px
     seam — so the `.on` tint ended in a curve and the pair read as two
     detached chips rather than a segmented control. The pair reads as one
     segmented control INSIDE `.split`'s pill — `.split` owns the outer
     silhouette and the chrome, and these two own only the seam. */
  .half-main,
  .half-caret {
    /* See .split — 20 + padding + border is what lands this on 26px. */
    height: 20px;
  }
  .half-main {
    border-radius: var(--tandem-r-pill) 0 0 var(--tandem-r-pill);
    padding: 0 5px 0 9px;
  }
  .half-caret {
    border-radius: 0 var(--tandem-r-pill) var(--tandem-r-pill) 0;
    padding: 0 6px;
    min-width: 20px;
  }
  /* Doubled class on purpose. Svelte 5 emits the scoping class on a
     DESCENDANT compound inside `:where()`, which adds no specificity — so this
     and `.ib svg` above are both (0,2,1) and the 12px chevron would win on
     source order alone. `.half-caret.half-caret` makes it (0,3,1), so moving
     this rule above `.ib svg` can no longer inflate the chevron to 16px and
     break the 20px half's geometry. */
  .half-caret.half-caret svg {
    width: 12px;
    height: 12px;
  }

  .split-div {
    width: 1px;
    height: 16px;
    background: var(--tandem-border);
    flex-shrink: 0;
  }

  /* dropdown */
  .menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 248px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-2);
    padding: var(--tandem-space-1);
    z-index: var(--tandem-z-dropdown);
  }
  .menu-head {
    padding: 7px 10px 3px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--tandem-font-mono);
  }
  .menu-help {
    margin: 0;
    padding: 0 10px 7px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    line-height: 1.4;
  }
  .mi {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--tandem-fg);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: var(--tandem-r-2);
    box-sizing: border-box;
  }
  .mi:hover,
  .mi:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }
  .mi-ic {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--tandem-fg-muted);
    display: inline-flex;
  }
  .mi-ic svg {
    width: 16px;
    height: 16px;
  }
  .mi-label {
    flex: 1;
  }
  .mi-tag {
    /* --tandem-fg-subtle (not -faint): faint fails the AA margin on small text
       (per the 1.7/1.8 audit decision); "· private" is a supplementary hint. */
    color: var(--tandem-fg-subtle);
    font-size: 11px;
  }
  .chk {
    width: 17px;
    height: 17px;
    border-radius: var(--tandem-r-1);
    border: 1px solid var(--tandem-border-strong);
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
  }
  .mi.on .chk {
    background: var(--tandem-accent);
    border-color: var(--tandem-accent);
  }
  .chk svg {
    width: 12px;
    height: 12px;
    color: var(--tandem-accent-fg);
    opacity: 0;
  }
  .mi.on .chk svg {
    opacity: 1;
  }
  .menu-div {
    height: 1px;
    background: var(--tandem-border);
    margin: 4px 6px;
  }
  .mi.link {
    color: var(--tandem-fg-muted);
    font-size: 12px;
    justify-content: space-between;
  }
  .mi.link kbd {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-subtle);
  }
</style>
