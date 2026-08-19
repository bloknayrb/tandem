<script lang="ts">
/**
 * One detected AI install, rendered as a selectable card in the integration
 * wizard's connect screen. Owns the status→friendly-line mapping; the
 * selectability decision itself lives in `isSelectable` (the hook) so the
 * card can never disagree with what `save()` will actually apply.
 *
 * Receives derived primitives (`selected` boolean, callbacks) rather than
 * the wizard object — passing getter-based hook state down and destructuring
 * it would freeze reactivity (see SettingsModal's getter-freezing gotcha).
 */
import type { ExistingMcpInstall } from "../../shared/integrations/contract.js";
import { isSelectable, tandemEntryValidationFailed } from "../hooks/useIntegrationWizard.svelte.js";
import { renderValidationReason, sanitizeReason } from "./integration-target-card-reason.js";

interface Props {
  install: ExistingMcpInstall;
  selected: boolean;
  onToggle: () => void;
}

let { install, selected, onToggle }: Props = $props();

const selectable = $derived(isSelectable(install));

// Testid identity. `kind` is NOT unique — a single Windows box can surface a
// classic AND an MSIX `claude-desktop` install, yielding duplicate testids
// (Playwright strict-mode throw). `configPath` is the natural key the `{#each}`
// and `save()` already use; slug it so the testid stays selector-safe.
// `$derived`, not `const`, so a reused card instance can't carry a stale slug.
const slug = $derived(
  install.target.configPath
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase(),
);

interface StatusLine {
  text: string;
  /** Maps to a `--tandem-{family}-fg-strong` color class; null = muted neutral. */
  family: "success" | "warning" | "error" | null;
  /** True when `text` is a diagnostic (a producer's `EntryValidation.reason`,
   *  a reduced form rebuilt from the entry, or a sanitized `errorMessage`)
   *  rather than hand-written copy — drives the monospace/wrap treatment so
   *  it reads as a diagnostic, not as body prose. */
  diagnostic?: boolean;
}

const statusLine = $derived.by((): StatusLine => {
  if (install.status === "error") {
    // #1422: `errorMessage` is a raw `readFile` failure and Node embeds the
    // path it was reading, so it is unbounded, path-bearing and never behind
    // any policy — run it through the same `sanitizeReason` floor (strip
    // control/bidi chars, clamp length) as a rendered reason, and mark it
    // `diagnostic` so it gets the same monospace/wrap treatment. It is the
    // longest string this card can render.
    const message = install.errorMessage ? sanitizeReason(install.errorMessage) : undefined;
    return {
      text: message ? `Couldn't check this one — ${message}` : "Couldn't check this one",
      family: "error",
      diagnostic: message !== undefined,
    };
  }
  if (install.status === "malformed") {
    return { text: "Settings file couldn't be read — we'll leave it alone", family: "warning" };
  }
  if (install.tandemEntry !== undefined) {
    if (tandemEntryValidationFailed(install) && install.tandemValidation !== undefined) {
      // #1422: surface the specific diagnostic instead of one fixed generic
      // line, so a malformed or hand-edited entry tells the user WHAT is
      // wrong instead of reading as "you configured something on purpose."
      // How much of each producer's string is safe to show is a per-status
      // policy — see `integration-target-card-reason.ts`.
      //
      // ONLY `tandemValidation` is rendered here, deliberately.
      // `channelValidation` also reaches the client on this same object, but
      // the tandem entry is what `isSelectable`/`save()` gate on, so it is
      // the one whose failure explains why this card is locked. A broken
      // `tandem-channel` entry is reported instead by the Done step's
      // aggregate push line (`refreshChannelRegistered`). Giving it a second
      // status line here is a UI question this fix did not answer — the
      // policy module itself is producer-agnostic, so the surface can be
      // added without changing it.
      const { text, diagnostic } = renderValidationReason(
        install.tandemValidation,
        install.tandemEntry,
      );
      return { text, family: "warning", diagnostic };
    }
    return { text: "Already connected — we'll refresh it", family: "success" };
  }
  if (install.status === "missing") {
    return { text: "Ready to connect (settings file will be created)", family: null };
  }
  return { text: "Ready to connect", family: null };
});
</script>

<label
  class="itc-card"
  class:is-selected={selected}
  class:is-locked={!selectable}
  data-testid="integration-wizard-card-{slug}"
>
  <input
    type="checkbox"
    class="itc-checkbox"
    checked={selected}
    disabled={!selectable}
    onchange={onToggle}
    data-testid="integration-wizard-pick-{slug}"
  />
  <span class="itc-icon" aria-hidden="true">
    {#if install.target.kind === "claude-code"}
      <!-- Terminal: window frame + prompt chevron + cursor bar -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
        <path d="M7 9l3 3-3 3" />
        <path d="M13 15h4" />
      </svg>
    {:else}
      <!-- Desktop app: window frame + title-bar rule -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
        <path d="M2 9h20" />
      </svg>
    {/if}
  </span>
  <span class="itc-text">
    <span class="itc-name">{install.target.label}</span>
    <span
      class="itc-status itc-status-{statusLine.family ?? 'neutral'}"
      class:itc-status-diagnostic={statusLine.diagnostic}
      >{statusLine.text}</span
    >
    <span class="itc-path">{install.target.configPath}</span>
  </span>
  <span class="itc-check" aria-hidden="true">
    {#if selectable}
      {#if selected}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      {:else}
        <span class="itc-check-empty"></span>
      {/if}
    {/if}
  </span>
</label>

<style>
  .itc-card {
    position: relative; /* containing block for the visually-hidden checkbox */
    display: grid;
    grid-template-columns: 28px 1fr 24px;
    align-items: start;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    background: var(--tandem-surface);
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background 140ms ease;
  }
  .itc-card:hover:not(.is-locked) {
    border-color: var(--tandem-border-strong);
    background: var(--tandem-surface-muted);
  }
  .itc-card.is-selected {
    border-color: var(--tandem-accent-border);
    background: var(--tandem-accent-bg);
  }
  .itc-card.is-locked {
    cursor: not-allowed;
    background: var(--tandem-surface-sunk);
    opacity: 0.75;
  }
  /* Keyboard focus lands on the visually-hidden checkbox; surface it on the card. */
  .itc-card:has(.itc-checkbox:focus-visible) {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
  }

  .itc-checkbox {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .itc-icon {
    width: 24px;
    height: 24px;
    margin-top: 1px;
    color: var(--tandem-fg-muted);
  }
  .itc-card.is-selected .itc-icon {
    color: var(--tandem-accent-fg-strong);
  }
  .itc-icon svg {
    width: 100%;
    height: 100%;
  }

  .itc-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .itc-name {
    font-size: var(--tandem-text-base);
    font-weight: 600;
    color: var(--tandem-fg);
  }
  .itc-status {
    font-size: var(--tandem-text-sm);
  }
  .itc-status-neutral {
    color: var(--tandem-fg-muted);
  }
  .itc-status-success {
    color: var(--tandem-success-fg-strong);
  }
  .itc-status-warning {
    color: var(--tandem-warning-fg-strong);
  }
  .itc-status-error {
    color: var(--tandem-error-fg-strong);
  }
  /* #1422: a rendered diagnostic (an EntryValidation.reason, or a sanitized
     errorMessage) gets mono + wrap, and deliberately NO font-size change.
     It inherits .itc-status's --tandem-text-sm because this line is the most
     important thing on the card when it appears -- it is the only place the
     user is told why Tandem refused their config. Shrinking it to
     --tandem-text-2xs (the de-emphasis size .itc-path uses for a path nobody
     needs to read) would render the explanation smaller than every generic
     status line beside it.
     overflow-wrap: anywhere, not .itc-path's word-break: break-all: these
     strings are prose plus a token (a command path, an expected arg tuple),
     so wrap at normal word boundaries first and force a mid-word break only
     as a last resort. break-all breaks at any character even when a normal
     wrap would have fit, which is right for one unbreakable path token and
     visibly wrong for a sentence. Both inputs can be long -- an
     invalid-command reason carries a full command path, and errorMessage is
     clamped only at 300 code points -- so the wrap is load-bearing on both
     branches that set this flag. */
  .itc-status-diagnostic {
    font-family: var(--tandem-font-mono);
    overflow-wrap: anywhere;
  }
  .itc-path {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    word-break: break-all;
  }

  .itc-check {
    width: 24px;
    height: 24px;
    color: var(--tandem-accent-fg-strong);
  }
  .itc-check svg {
    width: 100%;
    height: 100%;
  }
  .itc-check-empty {
    display: block;
    width: 16px;
    height: 16px;
    margin: 4px;
    border: 1.5px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-1);
  }

  @media (prefers-reduced-motion: reduce) {
    .itc-card {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .itc-card {
    transition: none;
  }
</style>
