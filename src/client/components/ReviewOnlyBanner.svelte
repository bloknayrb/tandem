<script lang="ts">
import { API_CONVERT } from "../../shared/api-paths";
import { API_BASE } from "../utils/fileUpload";
import "./tandem-banner.css";

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
    const res = await fetch(`${API_BASE}${API_CONVERT}`, {
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
    class="tandem-banner tandem-banner--info"
    role="status"
    aria-live="polite"
    data-testid="review-only-banner"
  >
    <span class="tandem-banner__message">
      This document is open in review-only mode. You can add annotations and review, but cannot
      edit directly.
    </span>
    {#if error}
      <span
        style="color: var(--tandem-error-fg-strong); font-size: var(--tandem-text-xs); max-width: 200px;"
      >
        {error}
      </span>
    {/if}
    {#if documentId}
      <button
        type="button"
        class="tandem-banner__cta"
        data-testid="convert-to-markdown-btn"
        onclick={handleConvert}
        disabled={converting}
      >
        {converting ? "Converting…" : "Convert to Markdown"}
      </button>
    {/if}
    <button
      type="button"
      class="tandem-banner__dismiss"
      data-testid="review-only-dismiss"
      onclick={handleDismiss}
      aria-label="Dismiss review-only banner"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M6 18L18 6" />
      </svg>
    </button>
  </div>
{/if}
