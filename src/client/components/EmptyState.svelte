<script lang="ts">
import { DISCONNECT_DEBOUNCE_MS } from "../../shared/constants";

interface Props {
  connected: boolean;
  claudeActive: boolean;
  /** State A primary — opens the file-open dialog. */
  onOpenFile: () => void;
  /** State C primary — retries the sync-server connection. */
  onRetry: () => void;
  /** State C ghost link — opens the settings modal. */
  onOpenSettings: () => void;
}

let { connected, claudeActive, onOpenFile, onRetry, onOpenSettings }: Props = $props();

let showDisconnected = $state(false);

// Debounce the disconnect state so a brief blip doesn't flash state C.
// PRESERVED VERBATIM across the D5 re-skin (#896): the cleanup closes over the
// local `timer` const, never a prop — touching it would reintroduce the
// prop-in-effect-cleanup hazard (v0.11.2). Do not "tidy" this block.
$effect(() => {
  if (connected) {
    showDisconnected = false;
    return;
  }
  const timer = setTimeout(() => {
    showDisconnected = true;
  }, DISCONNECT_DEBOUNCE_MS);
  return () => clearTimeout(timer);
});
</script>

<div class="empty-state">
  {#if showDisconnected}
    <!-- State C — server unavailable. The empty state users actually dwell on
         (state A is largely transient under the #842 auto-scratchpad gate). -->
    <div class="empty-illus" aria-hidden="true">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- left node (active) -->
        <circle cx="13" cy="36" r="9" stroke="var(--tandem-fg-faint)" stroke-width="1.5" fill="var(--tandem-surface)"/>
        <circle cx="13" cy="36" r="3.5" fill="var(--tandem-fg-faint)"/>
        <!-- right node (dim/unreachable) -->
        <circle cx="59" cy="36" r="9" stroke="var(--tandem-border-strong)" stroke-width="1.5" fill="var(--tandem-surface-muted)"/>
        <circle cx="59" cy="36" r="3.5" fill="var(--tandem-border-strong)"/>
        <!-- left wire segment -->
        <line x1="22" y1="36" x2="30" y2="36" stroke="var(--tandem-fg-faint)" stroke-width="1.5" stroke-linecap="round"/>
        <!-- right wire segment -->
        <line x1="42" y1="36" x2="50" y2="36" stroke="var(--tandem-border-strong)" stroke-width="1.5" stroke-linecap="round"/>
        <!-- break: X (error conveyed by geometry AND color, not color alone) -->
        <line x1="32" y1="31" x2="40" y2="41" stroke="var(--tandem-error)" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="40" y1="31" x2="32" y2="41" stroke="var(--tandem-error)" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="empty-heading">Server unavailable</p>
    <p class="empty-sub">Tandem can't reach its sync server. Make sure it's running locally.</p>
    <div class="empty-actions">
      <button class="empty-cta" data-testid="empty-state-retry" onclick={onRetry}>Retry</button>
      <button class="empty-link" data-testid="empty-state-open-settings" onclick={onOpenSettings}>
        Open settings
      </button>
    </div>
  {:else}
    <!-- State A — no document open. -->
    <div class="empty-illus" aria-hidden="true">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- back doc, offset up-left -->
        <rect x="11" y="10" width="36" height="46" rx="3"
              stroke="var(--tandem-border-strong)" stroke-width="1.2"
              fill="var(--tandem-surface-muted)"/>
        <!-- front doc -->
        <rect x="20" y="17" width="36" height="46" rx="3"
              stroke="var(--tandem-fg-faint)" stroke-width="1.5"
              fill="var(--tandem-surface)"/>
        <!-- content lines on front doc -->
        <line x1="27" y1="27" x2="49" y2="27" stroke="var(--tandem-border-strong)" stroke-width="1.1" stroke-linecap="round"/>
        <line x1="27" y1="33" x2="46" y2="33" stroke="var(--tandem-border-strong)" stroke-width="1.1" stroke-linecap="round"/>
        <line x1="27" y1="39" x2="49" y2="39" stroke="var(--tandem-border-strong)" stroke-width="1.1" stroke-linecap="round"/>
        <line x1="27" y1="45" x2="44" y2="45" stroke="var(--tandem-border-strong)" stroke-width="1.1" stroke-linecap="round"/>
        <!-- plus badge, top-right of front doc -->
        <circle cx="56" cy="16" r="9" fill="var(--tandem-surface)" stroke="var(--tandem-fg-faint)" stroke-width="1.5"/>
        <line x1="56" y1="11.5" x2="56" y2="20.5" stroke="var(--tandem-fg-faint)" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="51.5" y1="16" x2="60.5" y2="16" stroke="var(--tandem-fg-faint)" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="empty-heading">Nothing open yet</p>
    <p class="empty-sub">Click + in the tab bar, or drop a Markdown file here.</p>
    <div class="empty-actions">
      <button class="empty-cta" data-testid="empty-state-open-file" onclick={onOpenFile}>Open file…</button>
    </div>
    {#if connected && !claudeActive}
      <!-- Preserved from production: carries product positioning, not in the bundle. -->
      <p class="empty-sub empty-sub-secondary">
        Tandem works alongside Claude (the default integration) or any MCP-capable AI client.
      </p>
    {/if}
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 360px;
    text-align: center;
  }

  .empty-illus {
    margin-bottom: 22px;
    line-height: 0;
  }

  .empty-heading {
    font-family: var(--tandem-font-sans);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--tandem-fg);
    margin: 0 0 6px;
  }

  .empty-sub {
    font-family: var(--tandem-font-sans);
    font-size: 13px;
    line-height: 1.6;
    color: var(--tandem-fg-subtle);
    margin: 0 0 20px;
    max-width: 25ch;
    text-wrap: pretty;
  }

  .empty-sub-secondary {
    margin: 14px 0 0;
    color: var(--tandem-fg-faint);
  }

  .empty-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
  }

  .empty-cta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 16px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-fg);
    color: var(--tandem-bg);
    font-family: var(--tandem-font-sans);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
    border: none;
    cursor: pointer;
  }

  .empty-cta:hover {
    opacity: 0.88;
  }

  .empty-link {
    /* Interactive text: --tandem-fg-muted (≥5.5:1 in all themes) rather than
       the bundle's decorative --tandem-fg-faint, which fails WCAG AA 4.5:1
       (3.2 light / 2.9 warm / 4.0 dark). A11y overrides bundle decoration for
       a functional control; still clearly secondary to the inverted Retry pill. */
    font-family: var(--tandem-font-sans);
    font-size: 12.5px;
    color: var(--tandem-fg-muted);
    background: none;
    border: none;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: var(--tandem-border-strong);
  }

  .empty-link:hover {
    color: var(--tandem-fg);
  }

  .empty-cta:focus-visible,
  .empty-link:focus-visible {
    outline: 2px solid var(--tandem-accent-border);
    outline-offset: 2px;
  }
</style>
