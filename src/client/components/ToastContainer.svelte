<script lang="ts">
import type { Toast, ToastAnnouncement } from "../hooks/useNotifications.svelte";
import { formatActivityMessage, SEVERITY_GLYPHS } from "./activityCenter.js";
import { SR_ONLY_STYLE } from "./live-region";
import { toastAnnouncementText, toastFocusTarget, toastKey } from "./toast-focus";

interface Props {
  toasts: Toast[];
  /** Which toast each announcer speaks (#2489); see `ToastAnnouncement`. */
  announced: ToastAnnouncement;
  onDismiss: (id: string) => void;
}

let { toasts, announced, onDismiss }: Props = $props();

const uid = $props.id();

/**
 * #2489, announcements. The cards are inserted together with their text, the
 * shape `LiveRegion.svelte` documents as commonly announced by nothing, so the
 * cards carry no live role and these two permanently-mounted announcers speak
 * instead. Politeness is fixed per region (info polite, warning and error
 * assertive), never computed. A coalescing re-push carries its count, so the
 * sentence changes and is spoken again, as the badge visibly changes.
 */
const politeText = $derived(toastAnnouncementText(toasts, announced.polite));
const assertiveText = $derived(toastAnnouncementText(toasts, announced.assertive));

/**
 * #2489, focus. Where focus was before it entered the stack: set on every
 * focusin that comes from outside it. Plain `let`, not `$state` — nothing
 * renders it, and only the pre-effect below reads it.
 */
let returnTarget: Element | null = null;

function onStackFocusIn(event: FocusEvent): void {
  const stack = event.currentTarget as HTMLElement;
  const from = event.relatedTarget;
  // A null `relatedTarget` is also what the window's own refocus delivers
  // (switching back to the app re-fires focusin on the element that held
  // focus), so it is not evidence of where focus came from: keep the target
  // rather than wipe it. It is cleared when the stack empties instead.
  if (!(from instanceof Element) || stack.contains(from)) return;
  returnTarget = from;
}

// Runs BEFORE this update reaches the DOM, while a card about to go is still
// attached and still holds focus. Moving focus here, rather than after the
// removal (a `tick()`), is what keeps a press whose action opens a dialog
// working: the dialog mounts and takes focus later in the same flush, after
// this, so this never pulls focus back out of it. Reads only `toasts`; writes
// no state.
$effect.pre(() => {
  const target = toastFocusTarget(
    typeof document === "undefined" ? null : document.activeElement,
    new Set(toasts.map(toastKey)),
    returnTarget,
    new Set(toasts.filter((t) => t.action).map(toastKey)),
  );
  target?.focus({ preventScroll: true });
  // The stack is gone, so where focus came from before it is no longer news.
  if (toasts.length === 0) returnTarget = null;
});
</script>

<!-- Mounted always and outside the `{#if}`, so each sentence arrives as a
     mutation of a region already in the tree (#1431, #2489). The assertive one
     is written out because `LiveRegion` is deliberately polite-only. The
     `{#key}` on the announced id replaces the text node for every new toast:
     a second toast with the same sentence would otherwise leave the text
     unchanged, write nothing to the region, and be spoken by nothing. -->
<div role="status" aria-live="polite" style={SR_ONLY_STYLE} data-testid="toast-announcer-polite">{#key announced.polite}{politeText}{/key}</div>
<div role="alert" aria-live="assertive" style={SR_ONLY_STYLE} data-testid="toast-announcer-assertive">{#key announced.assertive}{assertiveText}{/key}</div>

{#if toasts.length > 0}
  <div data-testid="toast-container" class="toast-stack" onfocusin={onStackFocusIn}>
    <!-- Keyed on `toastKey`, which a coalescing re-push keeps although it
         changes the id: the card, and any focus inside it, survives the bump. -->
    {#each toasts as toast, i (toastKey(toast))}
      <div
        data-testid={`toast-${toast.id}`}
        data-toast-key={toastKey(toast)}
        data-toast-severity={toast.severity}
        class="toast-card {toast.severity}"
      >
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
            {#each SEVERITY_GLYPHS[toast.severity] as d (d)}
              <path {d} />
            {/each}
          </svg>
        </span>
        <div class="body">
          <span class="msg" id={`${uid}-msg-${i}`}>{formatActivityMessage(toast)}</span>
          {#if toast.count > 1}
            <span class="badge" data-testid={`toast-count-${toast.id}`}>×{toast.count}</span>
          {/if}
          {#if toast.action}
            <button
              type="button"
              class="action"
              aria-describedby={`${uid}-msg-${i}`}
              data-testid={`toast-action-${toast.id}`}
              onclick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          {/if}
        </div>
        <button
          type="button"
          class="dismiss"
          data-testid={`toast-dismiss-${toast.id}`}
          onclick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          aria-describedby={`${uid}-msg-${i}`}
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

<style>
  :global {
    @keyframes tandem-toast-slide-in {
      from {
        opacity: 0;
        transform: translateX(40px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  }

  .toast-stack {
    position: fixed;
    /* Sits above the activity pill (bottom: space-3, ~26px tall) + a gap. */
    bottom: calc(var(--tandem-space-3) + 26px + var(--tandem-space-2));
    right: var(--tandem-space-4);
    z-index: var(--tandem-z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
    max-width: 360px;
    pointer-events: none;
  }

  .toast-card {
    pointer-events: auto;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-4);
    padding: 10px;
    position: relative;
    animation: tandem-toast-slide-in 0.2s ease-out;
  }

  /* Reduced motion — this surface had NO guard at all (OS pref or in-app), unlike
     every other animated surface in the app. Dual mechanism, matching the
     ActivityTray/editor.css pattern. No `!important` needed here: `.toast-card` is
     a single-class selector, so the media query wins on order and the :global body
     selector wins on specificity. */
  @media (prefers-reduced-motion: reduce) {
    .toast-card {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .toast-card {
    animation: none;
  }

  .toast-card .glyph {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: var(--tandem-r-3);
    display: inline-grid;
    place-items: center;
  }
  .toast-card.info .glyph {
    background: color-mix(in srgb, var(--tandem-info) 14%, transparent);
    color: var(--tandem-info);
  }
  .toast-card.warning .glyph {
    background: color-mix(in srgb, var(--tandem-warning) 18%, transparent);
    color: var(--tandem-warning);
  }
  .toast-card.error .glyph {
    background: color-mix(in srgb, var(--tandem-error) 18%, transparent);
    color: var(--tandem-error);
  }

  .toast-card .body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-base);
    line-height: 1.4;
    color: var(--tandem-fg);
    padding-top: 2px;
  }
  /* Same defect as the tray row it feeds (#1269), and the same fix — a toast and
     its activity row render the identical `message` string, so a path that
     overflows one overflows the other. `min-width: 0` permits the shrink but
     supplies no break opportunity, and a Windows path is a single unbroken word.
     Here the card does not clip, so the text ran out past the rounded border
     instead of being sheared. See the fuller note in ActivityTray.svelte. */
  .toast-card .msg {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* Inline action button (#1018) — e.g. "Connect AI" on a no-AI-connected
     toast. Compact, accent-tinted, doesn't compete with the message. */
  .toast-card .action {
    flex: 0 0 auto;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    white-space: nowrap;
    padding: 2px 8px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-accent-border);
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent);
    cursor: pointer;
  }
  .toast-card .action:hover {
    background: var(--tandem-accent);
    color: var(--tandem-bg);
  }
  .toast-card .badge {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid transparent;
  }
  .toast-card.info .badge {
    background: var(--tandem-info-bg);
    color: var(--tandem-info-fg-strong);
    border-color: var(--tandem-info-border);
  }
  .toast-card.warning .badge {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-color: var(--tandem-warning-border);
  }
  .toast-card.error .badge {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-color: var(--tandem-error-border);
  }

  .toast-card .dismiss {
    flex: 0 0 auto;
    align-self: flex-start;
    width: 18px;
    height: 18px;
    border-radius: var(--tandem-r-2);
    background: transparent;
    border: none;
    color: var(--tandem-fg-subtle);
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    transition: background 100ms, color 100ms;
  }
  /* Reduced motion: the dismiss button still lights up on hover, it just gets
     there instantly. Same dual mechanism as the `.toast-card` guard above; no
     `!important` needed — the :global body selector outranks the plain one and
     the media half wins on source order. */
  :global(body.tandem-reduce-motion) .toast-card .dismiss {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .toast-card .dismiss {
      transition: none;
    }
  }
  .toast-card .dismiss:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }

  @media (forced-colors: active) {
    .toast-card {
      border: 1px solid CanvasText;
    }
    .toast-card .badge {
      border: 1px solid ButtonText;
    }
  }
</style>
