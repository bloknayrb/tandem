<script lang="ts">
import { onDestroy } from "svelte";
import type { ActivityItem } from "../hooks/useNotifications.svelte";
import "../panels/morphTiming.css";
import { resolveActivityAction } from "./activityActions.js";
import { relativeTime, SEVERITY_GLYPHS } from "./activityCenter.js";

interface Props {
  items: ActivityItem[];
  open: boolean;
  onToggle: () => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
  // Required (App is the only consumer): a row's action button is shown when
  // resolveActivityAction(item) is non-null, so an optional/forgotten handler
  // would render a silently-dead button.
  onAction: (item: ActivityItem) => void;
}

let { items, open, onToggle, onDismiss, onClear, onAction }: Props = $props();

const total = $derived(items.length);
// Highest-severity-wins: error outranks warning outranks info, else idle.
// Drives the shell tint + LED state (was `pillClass` pre-A23 single-shell morph).
// MUST stay `$derived.by` — a plain const would freeze at mount and the LED
// would never re-color as severities change.
const shellSeverity = $derived.by(() => {
  if (items.some((i) => i.severity === "error")) return "has-error";
  if (items.some((i) => i.severity === "warning")) return "has-warning";
  if (items.some((i) => i.severity === "info")) return "has-info";
  return "idle";
});

// Relative-time clock: tick every 30s so row labels age without a fresh event.
let now = $state(Date.now());
const clock = setInterval(() => {
  now = Date.now();
}, 30_000);

// Cascade-on-open window (A23). `.tray-inner` is conditionally rendered, so the
// rows mount fresh on every open and the rowSlideUp @keyframes fire on mount —
// no listEl bind / reflow trick needed (that's why this is ONE effect, not the
// bundle's two). We just flag `.tray-list.cascade` for ~1800ms so the staggered
// reveal runs exactly once per open. A notification arriving after the window
// simply appears (the bundle's per-row `.entering` solo-arrival path is deferred).
let cascading = $state(false);
let prevOpen = false; // plain latch — NOT $state (read+write in the effect would self-trigger)
let cascadeTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => {
  if (open && !prevOpen) {
    cascading = true; // written, never read here → creates no dependency, no loop
    if (cascadeTimer) clearTimeout(cascadeTimer);
    cascadeTimer = setTimeout(() => {
      cascading = false;
    }, 1800); // last row lands ~1510ms; window covers it
  } else if (!open && prevOpen) {
    cascading = false;
    if (cascadeTimer) {
      clearTimeout(cascadeTimer);
      cascadeTimer = undefined;
    }
  }
  prevOpen = open;
});

onDestroy(() => {
  clearInterval(clock);
  if (cascadeTimer) clearTimeout(cascadeTimer);
});
</script>

<div class="activity-anchor">
  <div class="activity-shell {shellSeverity}" class:open>
    <div class="tray-wrap">
      {#if open}
        <div class="tray-inner" id="activity-tray" role="region" aria-label="Activity" data-testid="activity-tray">
          <div class="tray-head">
            <span class="label">Activity</span>
            <span class="num">{total === 0 ? "No events" : `${total} event${total === 1 ? "" : "s"}`}</span>
            <span class="spacer"></span>
            {#if total > 0}
              <button type="button" data-testid="activity-clear-all" onclick={onClear}>Clear all</button>
            {/if}
          </div>
          {#if total === 0}
            <div class="tray-empty" data-testid="activity-empty">
              Nothing to report.
              <div class="sub">Saves, errors, and integration events appear here.</div>
            </div>
          {:else}
            <div class="tray-list" class:cascade={cascading}>
              {#each items as item (item.id)}
                {@const action = resolveActivityAction(item)}
                <div class="toast-row {item.severity}" data-testid={`activity-row-${item.id}`}>
                  <span class="glyph">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      {#each SEVERITY_GLYPHS[item.severity] as d (d)}
                        <path {d} />
                      {/each}
                    </svg>
                  </span>
                  <div class="body">
                    <div class="msg-row">
                      <span class="msg">{item.message}</span>
                      {#if item.count > 1}
                        <span class="badge">×{item.count}</span>
                      {/if}
                      <span class="ts">{relativeTime(item.timestamp, now)}</span>
                    </div>
                    {#if action}
                      <button
                        type="button"
                        class="action"
                        data-testid={`activity-action-${item.id}`}
                        onclick={() => onAction(item)}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M21 12a9 9 0 1 1-3-7" />
                          <path d="M21 4v5h-5" />
                        </svg>
                        {action.label}
                      </button>
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="dismiss"
                    data-testid={`activity-dismiss-${item.id}`}
                    onclick={() => onDismiss(item.id)}
                    aria-label="Dismiss activity item"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12" />
                      <path d="M6 18L18 6" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!--
      The pill row is the shell's always-visible bottom handle AND the toggle.
      No focus-return effect (unlike the M3 new-tab morph): this is a non-modal
      `role="region"`, toggled by this persistent button which is the close
      control and therefore already holds focus at close time. Adding focus
      management here would be dead code or would fight the natural focus.
    -->
    <button
      type="button"
      class="pill-row"
      data-testid="activity-pill"
      onclick={onToggle}
      aria-expanded={open}
      aria-controls={open ? "activity-tray" : undefined}
    >
      <span class="led"></span>
      {#if total === 0}
        <span>No activity</span>
      {:else}
        <span>Activity</span>
        <span class="count">{total}</span>
      {/if}
      <span class="spacer"></span>
      <span class="chev">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </button>
  </div>
</div>

<style>
  /* ════════════════════════════════════════════════════════
     ACTIVITY TRAY — single-shell morph (A23, #798 Phase 4)
     `.activity-shell` is the ONE element. `.tray-wrap` (the morphing body)
     sits ABOVE `.pill-row` (always-visible bottom handle / toggle). The shell
     is bottom-pinned absolute, so growing it taller makes the tray unfurl
     UPWARD while the pill stays put. Two-phase open: width+radius lead (P1),
     then max-height unfurls (P2, delayed P1). Close reverses the phase order.
     Timing tokens + reduced-motion (transitions) come from morphTiming.css.
     ════════════════════════════════════════════════════════ */
  .activity-anchor {
    position: fixed;
    bottom: var(--tandem-space-3);
    right: var(--tandem-space-4);
    z-index: var(--tandem-z-toast);
    pointer-events: none;
  }

  .activity-shell {
    pointer-events: auto;
    position: absolute;
    bottom: 0;
    right: 0;
    /* Fixed pixel width closed so width transitions smoothly to 340. */
    width: 144px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    box-shadow: var(--c7-pill-shadow);
    /* No backdrop-filter: --tandem-surface (the background above) is opaque, so
       a blur behind it never shows. Mirrors the .tandem-floating-pill recipe. */
    display: flex;
    flex-direction: column;
    /* clip (not hidden) so it's not a scroll container (lesson #765). The clip
       edge must stay at the border box (no clip-margin): the full-width, square
       `.pill-row` hover background and the body content otherwise bleed past the
       rounded shell — clip-margin == part of the radius reads as corners poking
       out of the pill / a shaved open-tray corner. No focusable control here
       carries an edge-hugging outline ring to bleed past it. */
    overflow: clip;
    overflow-clip-margin: 0;
    transform-origin: bottom right;
    /* OPEN: width + radius lead; box-shadow trails by P1. */
    transition:
      width var(--morph-p1) var(--tandem-ease-out),
      border-radius var(--morph-p1) var(--tandem-ease-out),
      box-shadow var(--morph-p2) var(--tandem-ease-out) var(--morph-p1),
      border-color 280ms ease;
  }
  .activity-shell.open {
    width: 340px;
    border-radius: var(--tandem-r-5);
    box-shadow: var(--c7-pill-shadow), 0 12px 32px -10px rgba(0, 0, 0, 0.18);
    border-color: var(--tandem-border-strong);
  }
  /* CLOSE: max-height collapses first (.tray-wrap), THEN width + radius (delay P2). */
  .activity-shell:not(.open) {
    transition:
      width var(--morph-p1) var(--tandem-ease-out) var(--morph-p2),
      border-radius var(--morph-p1) var(--tandem-ease-out) var(--morph-p2),
      box-shadow 440ms ease-in,
      border-color 280ms ease var(--morph-p2);
  }

  /* ── Pill row — always-on bottom edge of the shell + the toggle. ── */
  .pill-row {
    height: 26px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    border-top: 1px solid transparent;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg);
    cursor: pointer;
    transition: background 100ms ease, border-color 200ms ease 200ms;
    white-space: nowrap;
  }
  .activity-shell.open .pill-row {
    border-top-color: var(--tandem-border);
  }
  .pill-row:hover {
    background: var(--tandem-surface-sunk);
  }
  .activity-shell.idle .pill-row {
    color: var(--tandem-fg-subtle);
    font-family: var(--tandem-font-mono);
  }
  .pill-row .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tandem-fg-faint);
    transition: background 200ms ease;
    flex-shrink: 0;
  }
  .activity-shell.has-info .pill-row .led {
    background: var(--tandem-info);
  }
  .activity-shell.has-warning .pill-row .led {
    background: var(--tandem-warning);
    animation: ledpulse 1.6s ease-in-out infinite;
  }
  .activity-shell.has-error .pill-row .led {
    background: var(--tandem-error);
    animation: ledpulse 1.4s ease-in-out infinite;
  }
  @keyframes ledpulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  .pill-row .count {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg-muted);
    border: 1px solid var(--tandem-border);
  }
  .activity-shell.has-error .pill-row .count {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-color: var(--tandem-error-border);
  }
  .activity-shell.has-warning .pill-row .count {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-color: var(--tandem-warning-border);
  }
  .pill-row .spacer {
    flex: 1;
    min-width: 8px;
  }
  .pill-row .chev {
    width: 14px;
    height: 14px;
    color: var(--tandem-fg-faint);
    transition: transform 220ms var(--tandem-ease-out);
    display: inline-grid;
    place-items: center;
    margin-left: 2px;
  }
  .activity-shell.open .pill-row .chev {
    transform: rotate(180deg);
  }

  /* ── Tray body — grows above the pill row. max-height drives Phase 2. ── */
  .tray-wrap {
    max-height: 0;
    overflow: clip;
    overflow-clip-margin: var(--tandem-space-2);
    transition: max-height var(--morph-p2) cubic-bezier(0.4, 0, 0.6, 1);
  }
  .activity-shell.open .tray-wrap {
    max-height: 400px;
    transition: max-height var(--morph-p2) var(--tandem-ease-out) var(--morph-p1);
  }
  .tray-inner {
    display: flex;
    flex-direction: column;
  }

  .tray-head {
    display: flex;
    align-items: center;
    padding: 10px 12px 8px;
    gap: 8px;
  }
  .tray-head .label {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint);
  }
  .tray-head .num {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-muted);
  }
  .tray-head .spacer {
    flex: 1;
  }
  .tray-head button {
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
    background: transparent;
    border: none;
    border-radius: var(--tandem-r-2);
    padding: 2px 8px;
    cursor: pointer;
    transition: background 100ms, color 100ms;
  }
  .tray-head button:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }

  .tray-list {
    max-height: 288px;
    overflow-y: auto;
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 12px,
      black calc(100% - 12px),
      transparent 100%
    );
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 12px,
      black calc(100% - 12px),
      transparent 100%
    );
    padding: 4px 6px 8px;
  }
  .tray-list::-webkit-scrollbar {
    display: none;
  }

  /* Cascade-on-open: rows rise from the bottom into their stacked positions.
     Topmost (newest) lands first, each next ~110ms later. `--slide-y` is read
     inside the @keyframes (we animate `transform`, not the property itself), so
     no @property registration is needed. */
  .tray-list.cascade .toast-row {
    animation: rowSlideUp 420ms var(--tandem-ease-out) both;
  }
  .tray-list.cascade .toast-row:nth-child(1) {
    --slide-y: 240px;
    animation-delay: 540ms;
  }
  .tray-list.cascade .toast-row:nth-child(2) {
    --slide-y: 160px;
    animation-delay: 650ms;
  }
  .tray-list.cascade .toast-row:nth-child(3) {
    --slide-y: 84px;
    animation-delay: 760ms;
  }
  .tray-list.cascade .toast-row:nth-child(4) {
    --slide-y: 16px;
    animation-delay: 870ms;
  }
  .tray-list.cascade .toast-row:nth-child(5) {
    --slide-y: 8px;
    animation-delay: 980ms;
  }
  .tray-list.cascade .toast-row:nth-child(n + 6) {
    --slide-y: 6px;
    animation-delay: 1090ms;
  }
  @keyframes rowSlideUp {
    from {
      opacity: 0;
      transform: translateY(var(--slide-y, 24px));
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .tray-empty {
    padding: 20px 14px 24px;
    text-align: center;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-subtle);
  }
  .tray-empty .sub {
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-faint);
    margin-top: 4px;
  }

  .toast-row {
    display: flex;
    gap: 10px;
    padding: 10px 10px 10px 8px;
    border-radius: var(--tandem-r-4);
    position: relative;
    transition: background 120ms ease;
  }
  .toast-row:hover {
    background: var(--tandem-surface-sunk);
  }
  .toast-row + .toast-row {
    margin-top: 2px;
  }
  .toast-row .glyph {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: var(--tandem-r-3);
    display: inline-grid;
    place-items: center;
  }
  .toast-row.info .glyph {
    background: color-mix(in srgb, var(--tandem-info) 14%, transparent);
    color: var(--tandem-info);
  }
  .toast-row.warning .glyph {
    background: color-mix(in srgb, var(--tandem-warning) 18%, transparent);
    color: var(--tandem-warning);
  }
  .toast-row.error .glyph {
    background: color-mix(in srgb, var(--tandem-error) 18%, transparent);
    color: var(--tandem-error);
  }
  .toast-row .body {
    flex: 1;
    min-width: 0;
  }
  .toast-row .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-sm);
    line-height: 1.4;
    color: var(--tandem-fg);
  }
  .toast-row .msg {
    font-weight: 500;
    min-width: 0;
  }
  .toast-row .action {
    margin-top: 6px;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    font-weight: 500;
    height: 22px;
    padding: 0 10px;
    border-radius: var(--tandem-r-pill);
    background: transparent;
    border: 1px solid var(--tandem-border-strong);
    color: var(--tandem-fg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background 100ms, border-color 100ms;
  }
  .toast-row .action:hover {
    background: var(--tandem-surface-sunk);
    border-color: var(--tandem-fg-faint);
  }
  .toast-row .ts {
    margin-left: auto;
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    white-space: nowrap;
    padding-top: 1px;
    align-self: flex-start;
  }
  .toast-row .badge {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid transparent;
  }
  .toast-row.info .badge {
    background: var(--tandem-info-bg);
    color: var(--tandem-info-fg-strong);
    border-color: var(--tandem-info-border);
  }
  .toast-row.warning .badge {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-color: var(--tandem-warning-border);
  }
  .toast-row.error .badge {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-color: var(--tandem-error-border);
  }
  .toast-row .dismiss {
    align-self: flex-start;
    width: 18px;
    height: 18px;
    border-radius: var(--tandem-r-2);
    background: transparent;
    border: none;
    color: var(--tandem-fg-faint);
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    opacity: 0;
    transition: opacity 100ms, background 100ms, color 100ms;
  }
  .toast-row:hover .dismiss,
  .toast-row .dismiss:focus-visible {
    opacity: 0.9;
  }
  .toast-row .dismiss:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    opacity: 1;
  }

  /* Reduced motion — token-zeroing (morphTiming.css) covers the transitions, but
     NOT these @keyframes animations. Dual guard (OS pref + in-app body class).
     `!important` is required: the LED's `animation` lives on the 4-class severity
     selector `.activity-shell.has-error .pill-row .led`, which outranks any guard
     selector on specificity — so we must force it (matches the bundle's
     d1-toasts.css reduce-motion rule). Without it the LED keeps pulsing under
     reduced-motion (WCAG 2.2.2). */
  @media (prefers-reduced-motion: reduce) {
    .pill-row .led,
    .tray-list.cascade .toast-row {
      animation: none !important;
    }
  }
  :global(body.tandem-reduce-motion) .pill-row .led,
  :global(body.tandem-reduce-motion) .tray-list.cascade .toast-row {
    animation: none !important;
  }
</style>
