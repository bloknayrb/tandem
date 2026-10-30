<script lang="ts">
import { COWORK_ENABLED } from "../../shared/constants";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers";
import type { CoworkStatus } from "../types";
import CoworkOnboardingStep from "./CoworkOnboardingStep.svelte";

interface Props {
  reviewed: boolean;
  asked: boolean;
  edited: boolean;
  allDone: boolean;
  coworkDone: boolean;
  coworkStatus: CoworkStatus | null;
  onDismiss: () => void;
  onCoworkAdvance: () => void;
}

let {
  reviewed,
  asked,
  edited,
  allDone,
  coworkDone,
  coworkStatus,
  onDismiss,
  onCoworkAdvance,
}: Props = $props();

// #1824 item C: Ctrl+N belongs to the browser in a browser tab (opens a new
// window before Tandem ever sees the key) — the desktop app owns its own
// window, so the shortcut only works there. Matches user-guide.md's existing
// caveat for the same three browser-reserved shortcuts.
const tauri = isTauriRuntime();
const readyText = tauri
  ? "You're ready! Open a tab or scratchpad with Ctrl+N, jump anywhere with Ctrl+Shift+P, and press ? for every shortcut."
  : "You're ready! Open a tab or scratchpad with the + button in the tab bar, jump anywhere with Ctrl+Shift+P, and press ? for every shortcut.";

const items = $derived([
  {
    id: "review",
    done: reviewed,
    label: "Accept or dismiss a comment from Claude",
    hint: "Use the side panel or the margin view. Ctrl+Enter accepts the selected comment; Ctrl+Shift+Enter dismisses it.",
  },
  {
    id: "ask",
    done: asked,
    label: "Ask Claude something",
    hint: "Select text, click Annotate and send it to Claude, or type in the Chat panel.",
  },
  {
    id: "edit",
    done: edited,
    label: "Make an edit",
    hint: "Click in the document and type. Changes sync in real time.",
  },
]);

const skipped = readCoworkOnboardingSkipped();

// COWORK_ENABLED here as well as in useTutorial, so this component cannot
// show a row the hook's `allDone` does not wait for if a status is passed in.
const showCowork = $derived(
  COWORK_ENABLED && tauri && !coworkDone && shouldShowCoworkOnboarding(coworkStatus, skipped),
);

// The check-pop and the announcement fire only for an item that ticked while
// this strip was mounted. The strip remounts on every tab switch back to
// welcome.md and behind the wizard; an item already done at mount renders
// checked, silently, with no pop. Plain object, not `$state`: it is read and
// written only inside the effect below.
const doneAtMount: Record<string, boolean> = {};
let popped = $state<Record<string, boolean>>({});
let announcement = $state("");
$effect(() => {
  const ticked: string[] = [];
  for (const item of items) {
    const before = doneAtMount[item.id];
    if (before === undefined) {
      doneAtMount[item.id] = item.done;
    } else if (!before && item.done) {
      doneAtMount[item.id] = true;
      popped[item.id] = true;
      ticked.push(item.label);
    }
  }
  if (ticked.length > 0) {
    announcement = `Done: ${ticked.join(", ")}.${allDone ? " You're ready." : ""}`;
  }
});
</script>

<section
  data-testid="onboarding-tutorial"
  class="tut-strip"
  aria-label="Getting started"
>
  <span class="tut-lead">Getting started</span>
  <ul class="tut-items">
    {#each items as item (item.id)}
      <li
        data-testid="tutorial-item-{item.id}"
        data-done={item.done ? "true" : "false"}
        class="tut-item"
        class:is-done={item.done}
        title={item.hint}
      >
        <span class="tut-dot" class:is-popped={popped[item.id]} aria-hidden="true">
          {#if item.done}✓{/if}
        </span>
        <span class="tut-label">{item.label}</span>
        <span class="sr-only">{item.done ? "(done)" : "(to do)"} {item.hint}</span>
      </li>
    {/each}
  </ul>

  {#if allDone}
    <span class="tut-ready">{readyText}</span>
    <button data-testid="tutorial-next-btn" class="tut-done" onclick={onDismiss}>Done</button>
  {/if}

  <button
    data-testid="tutorial-dismiss-btn"
    class="tut-close"
    aria-label="Dismiss getting-started checklist"
    title="Dismiss"
    onclick={onDismiss}
  >
    ×
  </button>

  <div class="sr-only" role="status" aria-live="polite">{announcement}</div>

  {#if showCowork && coworkStatus !== null}
    <div class="tut-cowork">
      <CoworkOnboardingStep status={coworkStatus} onAdvance={onCoworkAdvance} />
    </div>
  {/if}
</section>

<style>
  /* Normal flow inside the top-of-shell banner stack, never `position: fixed`:
     the stack's single ResizeObserver measures it, and a fixed box has no height
     there (App.svelte, `.banner-stack`). It sits above the document rather than
     over it. */
  .tut-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tandem-space-2) var(--tandem-space-4);
    padding: var(--tandem-space-2) var(--tandem-space-4);
    background: var(--tandem-surface);
    border-bottom: 1px solid var(--tandem-border);
    border-left: 4px solid var(--tandem-accent);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }
  .tut-lead {
    font-weight: 600;
    color: var(--tandem-fg);
  }
  .tut-items {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tandem-space-1) var(--tandem-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tut-item {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-1);
    cursor: default;
  }
  .tut-item.is-done .tut-label {
    color: var(--tandem-fg-subtle);
    text-decoration: line-through;
  }
  .tut-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--tandem-space-4);
    height: var(--tandem-space-4);
    border-radius: var(--tandem-r-circle);
    border: 1px solid var(--tandem-border-strong);
    font-size: var(--tandem-text-xs);
    line-height: 1;
    transition: background 0.2s;
  }
  .tut-item.is-done .tut-dot {
    background: var(--tandem-accent);
    border-color: var(--tandem-accent);
    color: var(--tandem-accent-fg);
  }
  .tut-ready {
    color: var(--tandem-fg);
  }
  .tut-done {
    padding: var(--tandem-space-1) var(--tandem-space-3);
    font-size: var(--tandem-text-xs);
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface);
    color: var(--tandem-fg-muted);
    cursor: pointer;
    font-weight: 500;
  }
  .tut-close {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--tandem-text-base);
    line-height: 1;
    color: var(--tandem-fg-subtle);
    padding: 0 var(--tandem-space-1);
  }
  .tut-cowork {
    flex-basis: 100%;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Ticking an item is state feedback — the fill just lands. */
  :global(body.tandem-reduce-motion) .tut-dot {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tut-dot {
      transition: none;
    }
  }

  /* A22 (#798): a check pops once when its item ticks during this mount
     (`is-popped` is set only on a false→true transition, so a remount with the
     item already done does not replay it). */
  .tut-dot.is-popped {
    animation: tutorial-dot-pop 200ms var(--tandem-ease-out);
  }

  @keyframes tutorial-dot-pop {
    0% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.08);
    }
    100% {
      transform: scale(1);
    }
  }

  /* No app-wide reduced-motion catch-all exists — guard both surfaces explicitly. */
  @media (prefers-reduced-motion: reduce) {
    .tut-dot.is-popped {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .tut-dot.is-popped {
    animation: none;
  }
</style>
