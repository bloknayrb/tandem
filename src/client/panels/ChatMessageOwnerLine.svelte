<script lang="ts">
/**
 * The control line under one unanswered chat message (#2358 PR 5e; ownership
 * design §10.2, "Chat with no controlling badge"; Bryan, 2026-11-24, "A line
 * per message (Recommended)"): who holds the message, in 5b's words, then
 * Release (saying where it goes) where it applies, and "Assign…", which opens
 * the owners list (`GET /api/ownership/owners`, the list the badge's popover
 * reads, fetched on open) in a popover hung from the line. A refusal shows
 * inline on the line.
 *
 * Mounted only where `messageControlView` answers a view, which needs the
 * message's published facts, so a dark build never mounts it. It writes no
 * Y.Doc: every change goes through `POST /api/ownership` `{messageId, action,
 * ownerLabel?}`, and the result arrives as the server's republish.
 */
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
}

const { messageId, view }: Props = $props();

let error = $state<string | null>(null);
let pending = $state(false);
/** The open owners list's position (viewport coordinates), or null when closed. */
let menuAt = $state<{ left: number; top: number | null; bottom: number | null } | null>(null);
let choices = $state<OwnerChoice[] | null>(null);
let assignEl: HTMLButtonElement | null = $state(null);
let menuEl: HTMLDivElement | null = $state(null);

async function run(action: "release" | "assign", ownerLabel?: string) {
  if (pending) return;
  pending = true;
  error = null;
  const result = await postMessageOwnership(messageId, action, ownerLabel);
  pending = false;
  if (result.ok) menuAt = null;
  else error = messageOwnershipErrorText(result.error);
}

function toggleMenu() {
  if (menuAt !== null || assignEl === null) {
    menuAt = null;
    return;
  }
  // Fixed, so the messages list's overflow does not clip it; opened upward
  // when the line sits in the lower half of the window (the composer is below).
  const r = assignEl.getBoundingClientRect();
  menuAt =
    r.bottom > window.innerHeight / 2
      ? { left: r.left, top: null, bottom: window.innerHeight - r.top + 4 }
      : { left: r.left, top: r.bottom + 4, bottom: null };
  choices = null;
  void fetchOwnerChoices().then((list) => {
    if (menuAt !== null) choices = list ?? [];
  });
}

$effect(() => {
  if (menuAt === null) return;
  const stopOutside = onOutsideEvent(
    () => menuEl,
    ["mousedown"],
    (e) => {
      if (!assignEl?.contains(e.target as Node)) menuAt = null;
    },
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") menuAt = null;
  };
  document.addEventListener("keydown", onKey);
  return () => {
    stopOutside();
    document.removeEventListener("keydown", onKey);
  };
});
</script>

<div class="message-owner-line" data-testid={`chat-message-owner-${messageId}`}>
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
    <span class="message-owner-error" role="alert" data-testid={`chat-message-owner-error-${messageId}`}>
      {error}
    </span>
  {/if}
  {#if menuAt}
    <div
      bind:this={menuEl}
      class="message-owner-menu"
      role="dialog"
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
    z-index: 60;
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
