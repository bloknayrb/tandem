<script lang="ts">
import { aiRefusalUnverifiableMessage } from "../../shared/license-copy";
import { licenseStore } from "../hooks/useLicense.svelte";
import { aiOffCopy } from "../utils/license-ui";

// The rail's "AI features are off" notice (#1521, D3). A keyless install keeps a
// fully editable document and loses only the AI, so this explains the disabled
// AI controls below it. It sits above both Chat and Annotations. The pill chip
// in the status bar is the always-visible carrier; this is the explanation, and
// it is only on screen while the right rail is open.
//
// Renders nothing while `aiNotice` is null, which covers every dark build.
// No purchase link here, ever: it links to Settings → License, which decides
// whether this reader may be shown one (ADR-040 decision 8).

interface Props {
  /** Opens Settings → License. Required: a default would render a dead link. */
  onOpenLicenseSettings: () => void;
}
const { onOpenLicenseSettings }: Props = $props();

const COLLAPSED_KEY = "tandem:ai-off-notice-collapsed";

const notice = $derived(licenseStore.ui.aiNotice);
const unverifiableCode = $derived(licenseStore.status?.licenseUnverifiable ?? "UNKNOWN");

function readCollapsed(): boolean {
  // Storage-disabled browsers throw on access; fall back to expanded.
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = $state(readCollapsed());

function toggleCollapsed(): void {
  collapsed = !collapsed;
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Not persisted; the in-memory toggle still works for this session.
  }
}
</script>

{#if notice !== null}
  <div class="ai-off-notice" data-testid="ai-off-notice" role="status">
    <div class="ai-off-notice__head">
      <span class="ai-off-notice__title">
        {collapsed ? aiOffCopy(notice).short : "AI features are off"}
      </span>
      <button
        type="button"
        class="ai-off-notice__toggle"
        data-testid="ai-off-notice-collapse"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Show details" : "Hide details"}
        onclick={toggleCollapsed}
      >
        {collapsed ? "Show" : "Hide"}
      </button>
    </div>
    {#if !collapsed}
      <p class="ai-off-notice__body">
        {#if notice === "unverifiable"}
          {aiRefusalUnverifiableMessage(unverifiableCode)}
        {:else}
          AI features are off. Activate a license to bring Claude back.
        {/if}
      </p>
      <button
        type="button"
        class="ai-off-notice__link"
        data-testid="ai-off-notice-settings-link"
        onclick={onOpenLicenseSettings}
      >
        Settings → License
      </button>
    {/if}
  </div>
{/if}

<style>
.ai-off-notice {
  margin: var(--tandem-space-2);
  padding: var(--tandem-space-2) var(--tandem-space-3);
  font-size: var(--tandem-text-sm);
  line-height: 1.5;
  color: var(--tandem-warning-fg-strong);
  background: var(--tandem-warning-bg);
  border: 1px solid var(--tandem-warning-border);
  border-radius: var(--tandem-r-2);
}
.ai-off-notice__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--tandem-space-2);
}
.ai-off-notice__title {
  font-weight: 600;
}
.ai-off-notice__body {
  margin: var(--tandem-space-1) 0;
}
.ai-off-notice__toggle,
.ai-off-notice__link {
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
}
</style>
