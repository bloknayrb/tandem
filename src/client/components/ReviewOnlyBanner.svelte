<script lang="ts">
import { API_BASE } from "../utils/fileUpload";

const DISMISS_KEY = "tandem:reviewOnlyBannerDismissed";

interface Props {
  visible: boolean;
  documentId?: string;
}

let { visible, documentId }: Props = $props();

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

let dismissed = $state(readDismissed());
let converting = $state(false);
let error = $state<string | null>(null);

async function handleConvert() {
  if (!documentId || converting) return;
  converting = true;
  error = null;
  try {
    const res = await fetch(`${API_BASE}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      error = body?.message ?? `Conversion failed (HTTP ${res.status}).`;
    }
    // On success the server opens the new .md tab — Hocuspocus sync handles the rest
  } catch {
    error = "Could not reach the server.";
  } finally {
    converting = false;
  }
}

function handleDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    // storage unavailable
  }
  dismissed = true;
}
</script>

{#if visible && !dismissed}
  <div
    data-testid="review-only-banner"
    style="padding: var(--tandem-space-2) var(--tandem-space-4); background-color: var(--tandem-info-bg); border-bottom: 1px solid var(--tandem-info-border); display: flex; align-items: center; justify-content: space-between; font-size: var(--tandem-text-base); color: var(--tandem-info-fg-strong); gap: var(--tandem-space-3);"
  >
    <span>
      This document is open in review-only mode. You can add annotations and review, but cannot
      edit directly.
    </span>
    <div style="display: flex; align-items: center; gap: var(--tandem-space-2); flex-shrink: 0;">
      {#if error}
        <span style="color: var(--tandem-error-fg-strong); font-size: 12px; max-width: 200px;">
          {error}
        </span>
      {/if}
      {#if documentId}
        <button
          type="button"
          data-testid="convert-to-markdown-btn"
          onclick={handleConvert}
          disabled={converting}
          style="background: var(--tandem-info); border: none; color: var(--tandem-info-fg); cursor: {converting ? 'default' : 'pointer'}; font-weight: 500; font-size: var(--tandem-text-sm); padding: 4px 10px; border-radius: var(--tandem-r-2); white-space: nowrap; opacity: {converting ? 0.6 : 1};"
        >
          {converting ? "Converting…" : "Convert to Markdown"}
        </button>
      {/if}
      <button
        type="button"
        data-testid="review-only-dismiss"
        onclick={handleDismiss}
        style="background: none; border: none; color: var(--tandem-info-fg-strong); cursor: pointer; font-weight: 500; font-size: 13px; padding: 2px 8px; white-space: nowrap;"
      >
        Dismiss
      </button>
    </div>
  </div>
{/if}
