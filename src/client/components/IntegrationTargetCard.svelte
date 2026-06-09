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

interface Props {
  install: ExistingMcpInstall;
  selected: boolean;
  onToggle: () => void;
}

let { install, selected, onToggle }: Props = $props();

const selectable = $derived(isSelectable(install));

interface StatusLine {
  text: string;
  /** Maps to a `--tandem-{family}-fg-strong` color class; null = muted neutral. */
  family: "success" | "warning" | "error" | null;
}

const statusLine = $derived.by((): StatusLine => {
  if (install.status === "error") {
    return {
      text: install.errorMessage
        ? `Couldn't check this one — ${install.errorMessage}`
        : "Couldn't check this one",
      family: "error",
    };
  }
  if (install.status === "malformed") {
    return { text: "Settings file couldn't be read — we'll leave it alone", family: "warning" };
  }
  if (install.tandemEntry !== undefined) {
    if (tandemEntryValidationFailed(install)) {
      return { text: "Has a custom setup — we won't touch it", family: "warning" };
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
  data-testid="integration-wizard-card-{install.target.kind}"
>
  <input
    type="checkbox"
    class="itc-checkbox"
    checked={selected}
    disabled={!selectable}
    onchange={onToggle}
    data-testid="integration-wizard-pick-{install.target.kind}"
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
    <span class="itc-status itc-status-{statusLine.family ?? 'neutral'}">{statusLine.text}</span>
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
