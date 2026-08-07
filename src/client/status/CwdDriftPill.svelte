<script lang="ts">
import { clickOutside } from "../actions/clickOutside.svelte";
import { ESCAPE_OWNER_ATTR } from "../utils/escape-owner";
import { focusMenuEntryPoint, handleMenuArrowKeys } from "../utils/menuKeys";
import type { CwdDriftPill } from "./status-ai-view";

/**
 * Status-bar pill for the working-directory drift nudge (#1282).
 *
 * The pill is a menu trigger, not a one-click action, for two reasons:
 *
 *   - **The dismiss affordance has to be a real control.** A bare inline `×`
 *     lands at ~10-12px, which fails WCAG 2.2 SC 2.5.8 (24×24 minimum target) in
 *     a status bar where `.status-ai-indicator` already carries
 *     `min-height: 24px`. Three full-size menu rows clear it with room to spare.
 *     (The word-count button is also under 24px, but it is inline text that
 *     plausibly qualifies for SC 2.5.8's inline exception; a standalone glyph
 *     does not.)
 *   - **The menu is where the explanation fits.** A ten-pixel chip cannot teach
 *     a concept the user has never met — that Claude Code scopes what it can
 *     read to one directory — and the menu heading can.
 *
 * The menu also *is* the confirmation for opening the relaunch flow, which is
 * why the action row ends in an ellipsis: the flow itself still confirms, since
 * it interrupts Claude's current task and rewrites the stored working directory.
 */

interface Props {
  pill: CwdDriftPill;
  /** Open the relaunch-in-this-folder flow (which confirms before acting). */
  onRelaunch: () => void;
  /** Hide this (Claude's folder, target folder) pair for the session. */
  onDismiss: () => void;
  /** Stop showing the nudge entirely, across restarts. */
  onOptOut: () => void;
}

let { pill, onRelaunch, onDismiss, onOptOut }: Props = $props();

let menuOpen = $state(false);
let triggerBtn = $state<HTMLButtonElement | null>(null);
let menuEl = $state<HTMLDivElement | null>(null);
let wrapEl = $state<HTMLDivElement | null>(null);

$effect(() => {
  if (menuOpen) focusMenuEntryPoint(menuEl);
});

// Single close path, guarded exactly as `DecorationsMenu` guards its own:
// `clickOutside` fires on mousedown, before the browser moves focus, so
// restoring unconditionally would yank focus away from whatever was clicked.
function closeMenu(): void {
  const ours =
    (!!menuEl && menuEl.contains(document.activeElement)) ||
    document.activeElement === document.body ||
    document.activeElement === null;
  menuOpen = false;
  if (ours) triggerBtn?.focus();
}

function handleKey(e: KeyboardEvent): void {
  if (handleMenuArrowKeys(e)) return;
  if (e.key === "Escape" && menuOpen) {
    e.stopPropagation();
    closeMenu();
  }
}

/**
 * Run a menu row's handler, having first put focus somewhere that will still
 * exist afterwards.
 *
 * `unmounts` is the whole reason this takes a flag. `DecorationsMenu`, whose
 * close-guard this component copies, has a trigger that survives every action —
 * so restoring focus to it is right there and wrong here. Dismiss and
 * "don't show again" both flip suppression state that nulls the pill's own view,
 * unmounting this component AND `triggerBtn` with it: focus restored to the
 * trigger lands on a node removed microseconds later, and a keyboard user is
 * dumped on `<body>`. Hand focus to the status bar instead, which outlives us.
 *
 * `onRelaunch` keeps the trigger: it opens a modal confirm and leaves the pill
 * mounted, which is the case the copied guard was written for.
 */
function choose(run: () => void, { unmounts = false }: { unmounts?: boolean } = {}): void {
  if (unmounts) {
    // Read the fallback BEFORE closing — `wrapEl` is still attached here.
    const fallback = wrapEl?.closest<HTMLElement>("[data-status-focus-root]") ?? null;
    menuOpen = false;
    fallback?.focus();
    run();
    return;
  }
  closeMenu();
  run();
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={wrapEl}
  class="drift-wrap"
  data-testid="cwd-drift"
  use:clickOutside={closeMenu}
  onkeydown={handleKey}
  {...(menuOpen ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
>
  <button
    bind:this={triggerBtn}
    type="button"
    class="drift-pill"
    data-testid="cwd-drift-pill"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    title={pill.title}
    aria-label={pill.ariaLabel}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <span class="drift-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    </span>
    {pill.label}
  </button>

  {#if menuOpen}
    <div bind:this={menuEl} class="menu" role="menu" aria-label="Working folder">
      <div class="menu-head">Working folder</div>
      <p class="menu-help">{pill.explanation}</p>

      <button
        type="button"
        class="mi"
        data-testid="cwd-drift-relaunch"
        role="menuitem"
        onclick={() => choose(onRelaunch)}
      >
        {pill.actionLabel}
      </button>
      <button
        type="button"
        class="mi"
        data-testid="cwd-drift-dismiss"
        role="menuitem"
        onclick={() => choose(onDismiss, { unmounts: true })}
      >
        Not now
      </button>
      <div class="menu-div" role="separator"></div>
      <button
        type="button"
        class="mi link"
        data-testid="cwd-drift-opt-out"
        role="menuitem"
        onclick={() => choose(onOptOut, { unmounts: true })}
      >
        Don’t show this again
      </button>
    </div>
  {/if}
</div>

<style>
  .drift-wrap {
    position: relative;
    display: inline-flex;
  }

  /* The amber warning treatment shared with StatusBar's "Review Only" and
     "N held" pills — same tokens, same shape, rather than a fourth visual
     language for "something is off but nothing is broken".
     The values are restated rather than shared because Svelte scopes styles per
     component: StatusBar's `.status-warning-pill` rule cannot reach markup
     rendered here, so wearing that class would style nothing. Keep the two in
     step — the tokens are the contract, and a change here belongs in
     StatusBar's copy too. */
  .drift-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    /* WCAG 2.2 SC 2.5.8 — this is the dismiss/act affordance, so 24px is a
       floor, not a preference. */
    min-height: 24px;
    padding: 1px 8px;
    font: inherit;
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    color: var(--tandem-warning-fg-strong);
    background: var(--tandem-warning-bg);
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-warning-border);
    cursor: pointer;
    white-space: nowrap;
  }
  .drift-pill:hover {
    border-color: var(--tandem-warning);
  }
  .drift-pill:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .drift-ic {
    display: inline-flex;
    width: 13px;
    height: 13px;
  }
  .drift-ic svg {
    width: 13px;
    height: 13px;
  }

  /* Opens UPWARD — the status bar is the bottom edge of the window, so a
     `top: 100%` dropdown would render off-screen. */
  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 280px;
    max-width: 360px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-3);
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
    line-height: 1.45;
    /* Paths are long and unbreakable at spaces; without this the menu grows a
       horizontal scrollbar instead of wrapping. */
    overflow-wrap: anywhere;
  }
  .mi {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 24px;
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
    overflow-wrap: anywhere;
  }
  .mi:hover,
  .mi:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }
  .menu-div {
    height: 1px;
    background: var(--tandem-border);
    margin: 4px 6px;
  }
  .mi.link {
    color: var(--tandem-fg-muted);
    font-size: 12px;
  }

  /* Forced-colors: the amber fill is dropped by the OS palette, leaving the pill
     indistinguishable from plain status text. A border restores the boundary. */
  @media (forced-colors: active) {
    .drift-pill {
      border: 1px solid ButtonText;
    }
    .menu {
      border: 1px solid CanvasText;
    }
  }
</style>
