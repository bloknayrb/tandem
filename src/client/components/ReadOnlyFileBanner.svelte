<script lang="ts">
import type * as Y from "yjs";
import { API_READ_ONLY_FILE_RESOLVE } from "../../shared/api-paths";
import { Y_MAP_DOCUMENT_META, Y_MAP_READ_ONLY_FILE } from "../../shared/constants";
import type { ReadOnlyFileState } from "../../shared/types";
import { saveSkippedMessage } from "../actions/builtin.svelte.js";
import { API_BASE } from "../utils/fileUpload";
import LiveRegion from "./LiveRegion.svelte";
import "./tandem-banner.css";

/**
 * "This file is read-only on disk" prompt (#2273). Renders while the document's
 * Y_MAP_DOCUMENT_META carries a `ReadOnlyFileState` the user has not declined,
 * and disappears when the server clears it (a save landed, the file became
 * writable, or the content was reloaded). Modelled on ExternalConflictBanner,
 * including both in-flight pins — read that component for why each exists.
 *
 * Two exits, and deliberately not Save As: for a document that already saves
 * to its file, Save As is refused on both sides (it re-keys the annotation
 * store, see `saveDocumentAsToDisk`'s NOT_PROMOTABLE). On Windows the server
 * offers no Overwrite at all (`canOverwrite: false`), so the copy names the
 * Properties checkbox instead.
 */

interface Props {
  ydoc: Y.Doc;
  documentId: string;
  fileName: string;
}

const { ydoc, documentId, fileName }: Props = $props();

let prompt = $state<ReadOnlyFileState | null>(null);
let pending = $state<"overwrite" | "dismiss" | null>(null);
let error = $state<string | null>(null);

$effect(() => {
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
  // Untracked local, not $state, for the reason ExternalConflictBanner gives.
  let lastDetectedAt: number | undefined;
  const read = () => {
    const next = (meta.get(Y_MAP_READ_ONLY_FILE) as ReadOnlyFileState | undefined) ?? null;
    if (next?.detectedAt !== lastDetectedAt) {
      error = null;
      pending = null;
    }
    lastDetectedAt = next?.detectedAt;
    prompt = next;
  };
  read();
  const observer = (event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has(Y_MAP_READ_ONLY_FILE)) return;
    read();
  };
  meta.observe(observer);
  return () => {
    meta.unobserve(observer);
    prompt = null;
    error = null;
    pending = null;
  };
});

const visible = $derived(prompt !== null && !prompt.declined);

const message = $derived.by(() => {
  if (!prompt) return "";
  return prompt.canOverwrite
    ? `${fileName} is read-only on disk, so your edits haven't been saved. Overwrite it anyway (it stays read-only), or keep editing without saving.`
    : `${fileName} is read-only on disk, so your edits haven't been saved. To save them, clear Read-only in the file's Properties, then save again.`;
});

const announcement = $derived(visible ? [message, error].filter(Boolean).join(" ") : "");

async function resolve(choice: "overwrite" | "dismiss") {
  if (pending || !prompt) return;
  const forDoc = documentId;
  const forPrompt = prompt.detectedAt;
  const stillCurrent = () => forDoc === documentId && forPrompt === prompt?.detectedAt;
  pending = choice;
  error = null;
  try {
    const res = await fetch(`${API_BASE}${API_READ_ONLY_FILE_RESOLVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: forDoc, choice, detectedAt: forPrompt }),
    });
    const body = await res.json().catch(() => null);
    if (!stillCurrent()) return;
    if (!res.ok) {
      error = body?.message ?? `Request failed (HTTP ${res.status}).`;
      return;
    }
    // A landed save clears the flag and the observer hides the banner. One
    // that still did not land leaves it up, so say why here.
    const save = body?.data?.save as
      | { status?: string; skipCode?: string; reason?: string }
      | undefined;
    if (save?.status === "skipped") error = saveSkippedMessage(save.skipCode, save.reason);
    else if (save?.status === "error")
      error = `Save failed: ${save.reason ?? "The document could not be saved."}`;
  } catch {
    if (stillCurrent()) error = "Could not reach the server.";
  } finally {
    if (stillCurrent()) pending = null;
  }
}
</script>

<!-- Announcer as a sibling, not the banner itself, for the sticky-layout reason
     ExternalConflictBanner documents (#1431). -->
<LiveRegion srOnly message={announcement} data-testid="read-only-file-live" />

{#if visible && prompt}
  <div
    class="tandem-banner tandem-banner--warning tandem-banner--sticky"
    data-testid="read-only-file-banner"
  >
    <span class="tandem-banner__message" aria-hidden="true">{message}</span>
    {#if error}
      <span
        aria-hidden="true"
        style="color: var(--tandem-error-fg-strong); font-size: var(--tandem-text-xs); max-width: 200px;"
      >
        {error}
      </span>
    {/if}
    {#if prompt.canOverwrite}
      <button
        type="button"
        class="tandem-banner__cta"
        data-testid="read-only-file-overwrite-btn"
        onclick={() => resolve("overwrite")}
        disabled={pending !== null}
      >
        {pending === "overwrite" ? "Saving…" : "Overwrite"}
      </button>
    {/if}
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="read-only-file-dismiss-btn"
      onclick={() => resolve("dismiss")}
      disabled={pending !== null}
    >
      Not now
    </button>
  </div>
{/if}
