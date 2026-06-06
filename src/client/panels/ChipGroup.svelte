<script lang="ts">
import { tick, untrack } from "svelte";
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";

/**
 * A28→A15 (#798): a compact icon-chip filter group with a measured sliding
 * thumb. Replaces a native `<select>` (was `FilterSelect`). One axis (type /
 * author / status) per instance — a child COMPONENT, not a snippet, because each
 * group needs its own `$state` bar ref + measure `$effect` (a `{#snippet}` body
 * can't declare runes; reviewed 2026-06-01).
 *
 * The thumb-measure + radiogroup mechanics are reusable; the glyph vocabulary
 * (`IconName` below) is filter-specific by design — if a second consumer ever
 * needs a different icon set, lift the glyphs to the caller then.
 *
 * Reduced motion is a pure CSS concern here (the thumb is a CSS `left`/`width`
 * transition, which the `@media`/`body.tandem-reduce-motion` guards reach — no
 * `motionOff()` needed, unlike the JS transitions in `cardMotion.ts`).
 */

/** The static glyph set this component knows how to draw (see the `glyph` snippet). */
export type IconName =
  | "highlight"
  | "comment"
  | "lock"
  | "sparkle"
  | "pending"
  | "check"
  | "dismiss";

// Discriminated on `kind` so an icon chip MUST carry an `icon` and a pip chip a
// `pip` — a forgotten glyph is a type error at the call site, not a blank chip.
// `label` is the visible text for `kind:"text"` and the accessible name otherwise.
export type ChipOption =
  | { value: string; label: string; kind: "text" }
  | { value: string; label: string; kind: "icon"; icon: IconName }
  | { value: string; label: string; kind: "pip"; pip: "claude" | "user" | "import" };

interface Props {
  value: string;
  options: ChipOption[];
  onSet: (v: string) => void;
  groupAriaLabel: string;
  /** Root testid (e.g. `filter-type`); each chip is `{groupTestId}-{value}`. */
  groupTestId: string;
}

// Defaults keep the dev harness (renders without props) from throwing.
let {
  value = "",
  options = [],
  onSet = () => {},
  groupAriaLabel = "",
  groupTestId = "",
}: Props = $props();

// Roving tabindex + arrow/Home/End nav via the shared radiogroup hook (the same
// one Settings uses). The value SET is stable per axis (only labels change), so
// snapshotting it once is correct; `() => value` reads the live selection per
// key and the closure reads the live `onSet`.
// `untrack` reads `options` without subscribing — the value set is stable per
// axis at runtime (only labels change), so snapshotting once is intentional.
const chipValues = untrack(() => options.map((o) => o.value));
const rg = createRadioGroup<string>(
  () => value,
  chipValues,
  (v) => onSet(v),
);

let bar = $state<HTMLDivElement | null>(null);
// `ready` gates the CSS transition so the thumb SNAPS to its first position
// instead of sliding in from {0,0} (the transition only exists on `.ready`, so
// the before-change style has none → no animation on the first measure).
let thumb = $state({ left: 0, width: 0, ready: false });

function measure() {
  if (!bar) return;
  const el = bar.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!el) return; // transiently null between renders — guard the .offsetLeft throw
  const left = el.offsetLeft;
  const width = el.offsetWidth;
  if (thumb.ready) {
    // Transition already enabled — slide to the new position.
    thumb = { left, width, ready: true };
  } else {
    // First measure: snap to position (no transition), then enable in the next
    // frame so the thumb never slides in from {0,0}.
    thumb = { left, width, ready: false };
    requestAnimationFrame(() => {
      thumb = { left, width, ready: true };
    });
  }
}

// (1) Value-keyed measure. SYNCHRONOUS effect: capture the `value` dep at the
// top (tracking stops at the first `await`), then tick→rAF→measure so the new
// `aria-checked` chip is laid out before we read its box. Returns a real
// teardown function (an `async` callback would return a Promise, which Svelte
// ignores → the cancel flag would leak).
$effect(() => {
  void value;
  if (!bar) return;
  let cancelled = false;
  tick().then(() => {
    if (cancelled) return;
    requestAnimationFrame(() => {
      if (!cancelled) measure();
    });
  });
  return () => {
    cancelled = true;
  };
});

// (2) Mount-time ResizeObserver — depends ONLY on `bar`, so it is created once
// and torn down on destroy (NOT recreated per value change). The thumb is
// absolutely positioned, so it never resizes the bar → no measure feedback loop.
$effect(() => {
  if (!bar) return;
  const ro = new ResizeObserver(() => measure());
  ro.observe(bar);
  return () => ro.disconnect();
});
</script>

<div
  class="chip-bar"
  role="radiogroup"
  aria-label={groupAriaLabel}
  data-testid={groupTestId}
  bind:this={bar}
  onkeydown={rg.handleKeyDown}
>
  <span
    class="chip-thumb"
    class:ready={thumb.ready}
    style="left: {thumb.left}px; width: {thumb.width}px;"
    aria-hidden="true"
  ></span>
  {#each options as opt (opt.value)}
    {@const checked = opt.value === value}
    <button
      type="button"
      class="chip"
      class:is-checked={checked}
      role="radio"
      aria-checked={checked}
      aria-label={opt.label}
      title={opt.label}
      tabindex={rg.tabIndexFor(opt.value)}
      data-testid="{groupTestId}-{opt.value}"
      onclick={() => onSet(opt.value)}
    >
      {#if opt.kind === "text"}
        <span class="chip-text">{opt.label}</span>
      {:else if opt.kind === "pip"}
        <span class="pip pip-{opt.pip}"></span>
      {:else if opt.kind === "icon"}
        {@render glyph(opt.icon)}
      {/if}
    </button>
  {/each}
</div>

{#snippet glyph(name: IconName)}
  {#if name === "highlight"}
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h10"/><path d="M5 11l3 1 5-5-2-2-5 5z"/><path d="M9 4l2 2"/></svg>
  {:else if name === "comment"}
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3h11v8h-7l-3 2.5V11H2.5z"/></svg>
  {:else if name === "lock"}
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="6" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>
  {:else if name === "sparkle"}
    <svg class="g-suggestion" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M8 10v4"/><path d="M2 8h4"/><path d="M10 8h4"/><path d="M4 4l1.5 1.5"/><path d="M10.5 10.5L12 12"/><path d="M12 4l-1.5 1.5"/><path d="M5.5 10.5L4 12"/></svg>
  {:else if name === "pending"}
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5"/></svg>
  {:else if name === "check"}
    <svg class="g-success" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>
  {:else if name === "dismiss"}
    <svg class="g-error" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
  {/if}
{/snippet}

<style>
  .chip-bar {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--tandem-surface-muted);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
  }
  .chip-thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 0 0 1px var(--tandem-border-strong);
    opacity: 0;
    z-index: 0;
  }
  /* Transition lives only on `.ready`, so the first measure snaps (no slide-in
     from 0). Subsequent value changes animate left/width. */
  .chip-thumb.ready {
    opacity: 1;
    transition: left 240ms var(--tandem-ease-out), width 240ms var(--tandem-ease-out);
  }
  .chip {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border: none;
    background: none;
    color: var(--tandem-fg-subtle);
    border-radius: var(--tandem-r-pill);
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    white-space: nowrap;
  }
  .chip:hover {
    color: var(--tandem-fg-muted);
  }
  .chip.is-checked {
    color: var(--tandem-fg);
  }
  .chip:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .chip svg {
    display: block;
  }
  .g-suggestion {
    color: var(--tandem-suggestion-fg-strong);
  }
  .g-success {
    color: var(--tandem-success-fg-strong);
  }
  .g-error {
    color: var(--tandem-error-fg-strong);
  }
  .pip {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }
  .pip-claude {
    background: var(--tandem-author-claude);
  }
  .pip-user {
    background: var(--tandem-author-user);
  }
  .pip-import {
    background: var(--tandem-fg-subtle);
  }

  /* Dual reduced-motion guard (CSS-only — the thumb is a CSS transition). */
  @media (prefers-reduced-motion: reduce) {
    .chip-thumb.ready {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .chip-thumb.ready {
    transition: none;
  }
</style>
