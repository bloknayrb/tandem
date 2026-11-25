<script lang="ts">
/**
 * The control line under one unanswered chat message (#2358 PR 5e; ownership
 * design §10.2, "Chat with no controlling badge"; Bryan, 2026-11-24, "A line
 * per message (Recommended)"): who holds the message, in 5b's words, then
 * Release (saying where it goes) where it applies, and "Assign…", which opens
 * the owners list (`GET /api/ownership/owners`, the list the badge's popover
 * reads, fetched on open) in a popover hung from the line. A refusal shows
 * inline on the line, and the chat panel speaks it through its always-mounted
 * announcer (`onerror`; #1431, #2489): this line's own nodes are inserted
 * together with their text, and a refusal such as "already answered" can
 * unmount the line before it is read.
 *
 * The owners list is moved to `<body>` while open (`toBody`): the messages list
 * carries a scroll-fade `mask-image`, which clips and fades every descendant's
 * painting to the list's box, `position: fixed` included. Since it then sits
 * last in the document, it takes focus when it opens, as 5b's badge popover
 * does, and closes when focus moves to anything outside it.
 *
 * Mounted only where `messageControlView` answers a view, which needs the
 * message's published facts, so a dark build never mounts it. It writes no
 * Y.Doc: every change goes through `POST /api/ownership` `{messageId, action,
 * ownerLabel?}`, and the result arrives as the server's republish.
 */
import { tick, untrack } from "svelte";
import {
  holderName,
  type MessageControlView,
  messageOwnershipErrorText,
} from "../ownership/owner-view";
import {
  fetchOwnerChoices,
  type OwnerChoice,
  postMessageOwnership,
} from "../ownership/ownership-api";
import { onOutsideEvent } from "../utils/dismiss-outside";

interface Props {
  messageId: string;
  view: MessageControlView;
  /**
   * The refusal shown now, or null at each new attempt: the chat panel speaks
   * it through its always-mounted announcer, so this line's visible copy is
   * `aria-hidden`.
   */
  onerror?: (text: string | null) => void;
}

const { messageId, view, onerror }: Props = $props();

let error = $state<string | null>(null);
let pending = $state(false);
/** The open owners list's position (viewport coordinates), or null when closed. */
let menuAt = $state<{ left: number; top: number | null; bottom: number | null } | null>(null);
let choices = $state<OwnerChoice[] | null>(null);
let assignEl: HTMLButtonElement | null = $state(null);
let menuEl: HTMLDivElement | null = $state(null);
let lineEl: HTMLDivElement | null = $state(null);

/**
 * Move the owners list to `<body>` for as long as it is open, out of the
 * messages list's scroll-fade mask (see the header), then focus it: here, not
 * in an effect, because moving a focused node drops its focus. Removed on
 * teardown too, so a line unmounted with its list open leaves nothing behind.
 */
function toBody(node: HTMLElement) {
  document.body.appendChild(node);
  node.focus({ preventScroll: true });
  return {
    destroy() {
      node.remove();
    },
  };
}

// Bumped on every open and close, so an owners list fetched for an earlier
// opening never fills a later one (5b's late-result rule for the badge popover).
let menuGeneration = 0;

/** Whether focus sits nowhere: it was in something that has just left the DOM. */
function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Close the owners list. With `refocus`, and only when focus then sits
 * nowhere (it was on a row of the list that has just gone), focus goes back
 * to "Assign…", as 5b's badge popover hands it back to its badge.
 */
async function closeMenu(refocus = false) {
  if (menuAt === null) return;
  menuGeneration++;
  menuAt = null;
  if (!refocus) return;
  await tick();
  if (focusLost() && assignEl?.isConnected) assignEl.focus();
}

async function run(action: "release" | "assign", ownerLabel?: string) {
  if (pending) return;
  pending = true;
  error = null;
  onerror?.(null);
  const result = await postMessageOwnership(messageId, action, ownerLabel);
  pending = false;
  if (result.ok) {
    await closeMenu(true);
    // A Release with no list open: its button was disabled while the request
    // ran, which dropped focus. The line stays up until the republish arrives,
    // so focus comes back to a control on it rather than staying on <body>.
    await tick();
    if (focusLost() && lineEl?.isConnected) {
      lineEl
        .querySelector<HTMLButtonElement>("button.message-owner-action:not(:disabled)")
        ?.focus();
    }
    return;
  }
  error = messageOwnershipErrorText(result.error);
  onerror?.(error);
  // The pressed control was disabled while the request ran, which dropped
  // focus; a refusal keeps the line (and an open list) up, so focus comes back.
  await tick();
  if (!focusLost()) return;
  const firstChoice = menuEl?.querySelector<HTMLButtonElement>("button:not(:disabled)");
  (firstChoice ?? assignEl)?.focus();
}

/** The menu's widest box (`max-width` below) plus the 8px margin it keeps from the window's edge. */
const MENU_MAX_WIDTH = 320;
const EDGE = 8;

function toggleMenu() {
  if (menuAt !== null || assignEl === null) {
    void closeMenu();
    return;
  }
  // Fixed and moved to <body> (`toBody`), so neither the messages list's
  // overflow nor its scroll-fade mask clips it; opened upward
  // when the line sits in the lower half of the window (the composer is below),
  // and kept inside the window's right edge (the chat panel usually sits there).
  const r = assignEl.getBoundingClientRect();
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - MENU_MAX_WIDTH - EDGE));
  menuAt =
    r.bottom > window.innerHeight / 2
      ? { left, top: null, bottom: window.innerHeight - r.top + 4 }
      : { left, top: r.bottom + 4, bottom: null };
  choices = null;
  const generation = ++menuGeneration;
  void fetchOwnerChoices().then((list) => {
    if (generation === menuGeneration && menuAt !== null) choices = list ?? [];
  });
}

$effect(() => {
  if (menuAt === null) return;
  // A scroll anywhere outside the list closes it too: it is fixed, so it would
  // otherwise stay put while its line scrolls away (a new message's autoscroll).
  const stopOutside = onOutsideEvent(
    () => menuEl,
    ["mousedown", "scroll"],
    (e) => {
      if (!assignEl?.contains(e.target as Node)) void closeMenu();
    },
  );
  const onKey = (e: KeyboardEvent) => {
    // Another handler already took this Escape (the command palette's capture
    // listener closes itself and preventDefaults), or an IME is composing (the
    // composer sits in the same panel): 5b's badge popover rule.
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === "Escape") void closeMenu(true);
  };
  document.addEventListener("keydown", onKey);
  return () => {
    stopOutside();
    document.removeEventListener("keydown", onKey);
  };
});

// The list takes focus when it opens (`toBody`; it sits last in the
// document, so Tab from "Assign…" would never reach it): itself until the
// owners list brings a row, then its first row if focus is still parked on it.
$effect(() => {
  if (!choices || !menuEl) return;
  const el = menuEl;
  untrack(() => {
    if (document.activeElement === el) {
      el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    }
  });
});

// A republish that stops offering Assign (the message now follows its
// document, say) takes the open list with it, as 5b's popover goes when its
// entry loses its owner fields.
$effect(() => {
  if (view.assign) return;
  untrack(() => void closeMenu(true));
});

/** Focus moved to something outside the list and its "Assign…": close it. */
function onMenuFocusOut(e: FocusEvent) {
  const next = e.relatedTarget;
  // No target: a pressed row was disabled while its request runs, or focus
  // left the window. Neither is a move elsewhere in the editor.
  if (!(next instanceof Node)) return;
  if (menuEl?.contains(next) || assignEl?.contains(next)) return;
  void closeMenu();
}
</script>

<div class="message-owner-line" bind:this={lineEl} data-testid={`chat-message-owner-${messageId}`}>
  <span>{view.holder}</span>
  {#if view.release}
    <button
      type="button"
      class="message-owner-action"
      data-testid={`chat-message-owner-release-${messageId}`}
      disabled={pending}
      onclick={() => void run("release")}
    >
      {view.release}
    </button>
  {/if}
  {#if view.assign}
    <button
      type="button"
      bind:this={assignEl}
      class="message-owner-action"
      data-testid={`chat-message-owner-assign-${messageId}`}
      aria-haspopup="dialog"
      aria-expanded={menuAt !== null}
      disabled={pending}
      onclick={toggleMenu}
    >
      Assign…
    </button>
  {/if}
  {#if error}
    <!-- Not a live region: inserted together with its text, which is commonly
         announced by nothing (#1431). The chat panel's always-mounted
         `chat-message-owner-announcer` speaks it (`onerror`). -->
    <span class="message-owner-error" aria-hidden="true" data-testid={`chat-message-owner-error-${messageId}`}>
      {error}
    </span>
  {/if}
  {#if menuAt}
    <div
      bind:this={menuEl}
      use:toBody
      class="message-owner-menu"
      role="dialog"
      tabindex="-1"
      onfocusout={onMenuFocusOut}
      aria-label="Assign this message"
      data-testid="chat-message-owner-menu"
      style:left={`${menuAt.left}px`}
      style:top={menuAt.top === null ? undefined : `${menuAt.top}px`}
      style:bottom={menuAt.bottom === null ? undefined : `${menuAt.bottom}px`}
    >
      {#if choices !== null && choices.length === 0}
        <div class="message-owner-empty">No session can take it now</div>
      {/if}
      {#each choices ?? [] as choice (choice.label)}
        <button
          type="button"
          class="message-owner-choice"
          data-testid={`chat-message-owner-choice-${choice.label}`}
          disabled={pending}
          onclick={() => void run("assign", choice.label)}
        >
          <span>{holderName(choice)}</span>
          {#if choice.holds.length > 0}
            <span class="message-owner-sub">holds {choice.holds.map((h) => `“${h}”`).join(", ")}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .message-owner-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--tandem-space-2);
    margin: calc(-1 * var(--tandem-space-2)) 0 var(--tandem-space-3);
    padding: 0 var(--tandem-space-3);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }
  .message-owner-action {
    border: 0;
    background: transparent;
    color: var(--tandem-fg-subtle);
    font: inherit;
    cursor: pointer;
    padding: 2px 4px;
  }
  .message-owner-action:hover:not(:disabled),
  .message-owner-action:focus-visible {
    color: var(--tandem-accent-fg-strong);
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
    border-radius: var(--tandem-r-2);
  }
  .message-owner-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .message-owner-error {
    flex-basis: 100%;
    color: var(--tandem-error-fg-strong);
  }
  .message-owner-menu {
    position: fixed;
    z-index: var(--tandem-z-popover);
    min-width: 200px;
    max-width: 320px;
    padding: var(--tandem-space-1);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    box-shadow: var(--tandem-shadow-2);
    font-size: var(--tandem-text-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .message-owner-empty {
    padding: var(--tandem-space-1) var(--tandem-space-2);
    color: var(--tandem-fg-muted);
  }
  .message-owner-choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    padding: var(--tandem-space-1) var(--tandem-space-2);
    background: none;
    border: none;
    border-radius: var(--tandem-r-1);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .message-owner-choice:hover:not(:disabled),
  .message-owner-choice:focus-visible {
    background: var(--tandem-surface-muted);
  }
  .message-owner-choice:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .message-owner-sub {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
    overflow-wrap: anywhere;
  }
</style>
