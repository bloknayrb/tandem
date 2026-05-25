<script lang="ts">
import { onDestroy } from "svelte";
import type { ActivityItem } from "../hooks/useNotifications.svelte";
import { relativeTime, SEVERITY_GLYPHS } from "./activityCenter.js";

interface Props {
  items: ActivityItem[];
  open: boolean;
  onToggle: () => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
}

let { items, open, onToggle, onDismiss, onClear }: Props = $props();

const total = $derived(items.length);
// Highest-severity-wins: error outranks warning outranks info, else idle.
const pillClass = $derived.by(() => {
  if (items.some((i) => i.severity === "error")) return "has-error";
  if (items.some((i) => i.severity === "warning")) return "has-warning";
  if (items.some((i) => i.severity === "info")) return "has-info";
  return "idle";
});

// Relative-time clock: tick every 30s so row labels age without a fresh event.
// `onDestroy` keeps the single cleanup story (the store owns its own timers).
let now = $state(Date.now());
const clock = setInterval(() => {
  now = Date.now();
}, 30_000);
onDestroy(() => clearInterval(clock));
</script>

<div class="activity-anchor">
  {#if open}
    <div class="activity-tray" id="activity-tray" role="region" aria-label="Activity" data-testid="activity-tray">
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
        <div class="tray-list">
          {#each items as item (item.id)}
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
  <button
    type="button"
    class="activity-pill {pillClass}"
    class:open
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

<style>
  .activity-anchor {
    position: fixed;
    bottom: var(--tandem-space-3);
    right: var(--tandem-space-4);
    z-index: var(--tandem-z-toast);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--tandem-space-2);
    pointer-events: none;
  }
  .activity-anchor > * {
    pointer-events: auto;
  }

  /* Collapsed pill — mirrors the StatusBar pill recipe. */
  .activity-pill {
    height: 26px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    box-shadow: var(--c7-pill-shadow);
    backdrop-filter: saturate(140%) blur(8px);
    -webkit-backdrop-filter: saturate(140%) blur(8px);
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg);
    cursor: pointer;
    transition: background 100ms ease, border-color 200ms ease;
  }
  .activity-pill:hover {
    background: var(--tandem-surface-muted);
  }
  .activity-pill.idle {
    color: var(--tandem-fg-subtle);
    font-family: var(--tandem-font-mono);
  }
  .activity-pill .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tandem-fg-faint);
    transition: background 200ms ease;
  }
  .activity-pill.has-info .led {
    background: var(--tandem-info);
  }
  .activity-pill.has-warning .led {
    background: var(--tandem-warning);
  }
  .activity-pill.has-error .led {
    background: var(--tandem-error);
  }
  .activity-pill .count {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg-muted);
    border: 1px solid var(--tandem-border);
  }
  .activity-pill.has-error .count {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-color: var(--tandem-error-border);
  }
  .activity-pill.has-warning .count {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-color: var(--tandem-warning-border);
  }
  .activity-pill .chev {
    width: 14px;
    height: 14px;
    color: var(--tandem-fg-faint);
    transition: transform 150ms ease;
    display: inline-grid;
    place-items: center;
  }
  .activity-pill.open .chev {
    transform: rotate(180deg);
  }

  /* Expanded tray. */
  .activity-tray {
    width: 340px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    box-shadow: var(--c7-pill-shadow), 0 10px 30px -8px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    transform-origin: bottom right;
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
    max-height: 320px;
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
</style>
