<script lang="ts">
import type * as Y from "yjs";
import { API_DOCX_CONFLICT_RESOLVE } from "../../shared/api-paths";
import { Y_MAP_DOCUMENT_META, Y_MAP_EXTERNAL_CONFLICT } from "../../shared/constants";
import type { ExternalConflictState } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";
import "./tandem-banner.css";

/**
 * Keep-vs-reload prompt for `.docx` external conflicts (#1069).
 *
 * Server-authoritative: the banner renders while the document's
 * Y_MAP_DOCUMENT_META carries an `ExternalConflictState` under
 * Y_MAP_EXTERNAL_CONFLICT, and disappears when the server clears it (resolve
 * choice, reload, or explicit save). Non-blocking banner, not a modal — the
 * default (do nothing) keeps the unsaved in-memory edits, matching the
 * server's restore behavior.
 */

interface Props {
  ydoc: Y.Doc;
  documentId: string;
  fileName: string;
}

const { ydoc, documentId, fileName }: Props = $props();

let conflict = $state<ExternalConflictState | null>(null);
let pending = $state<"keep" | "reload" | null>(null);
let error = $state<string | null>(null);

$effect(() => {
  // Track the ydoc prop — re-observe when the active tab's doc changes.
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
  const read = () => {
    conflict = (meta.get(Y_MAP_EXTERNAL_CONFLICT) as ExternalConflictState | undefined) ?? null;
  };
  read();
  const observer = (event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has(Y_MAP_EXTERNAL_CONFLICT)) return;
    read();
  };
  meta.observe(observer);
  return () => {
    meta.unobserve(observer);
    conflict = null;
    error = null;
    pending = null;
  };
});

const message = $derived.by(() => {
  if (!conflict) return "";
  if (conflict.kind === "external-edit") {
    return `${fileName} changed on disk while you have unsaved edits. Keeping your edits means your next save overwrites the disk changes; reloading discards your unsaved edits.`;
  }
  return conflict.diskChanged
    ? `Unsaved edits for ${fileName} were restored from your last session, but the file also changed on disk. Keep your restored edits, or reload the file from disk (discards them)?`
    : `Unsaved edits for ${fileName} were restored from your last session. Keep them, or reload fresh from the file on disk (discards them)?`;
});

async function resolve(choice: "keep" | "reload") {
  if (pending) return;
  pending = choice;
  error = null;
  try {
    const res = await fetch(`${API_BASE}${API_DOCX_CONFLICT_RESOLVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, choice }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      error = body?.message ?? `Request failed (HTTP ${res.status}).`;
    }
    // On success the server clears the meta flag — the observer hides the banner.
  } catch {
    error = "Could not reach the server.";
  } finally {
    pending = null;
  }
}
</script>

{#if conflict}
  <div
    class="tandem-banner tandem-banner--warning"
    role="status"
    aria-live="polite"
    data-testid="docx-conflict-banner"
  >
    <span class="tandem-banner__message">{message}</span>
    {#if error}
      <span
        style="color: var(--tandem-error-fg-strong); font-size: var(--tandem-text-xs); max-width: 200px;"
      >
        {error}
      </span>
    {/if}
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="docx-conflict-keep-btn"
      onclick={() => resolve("keep")}
      disabled={pending !== null}
    >
      {pending === "keep" ? "Keeping…" : "Keep my edits"}
    </button>
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="docx-conflict-reload-btn"
      onclick={() => resolve("reload")}
      disabled={pending !== null}
    >
      {pending === "reload" ? "Reloading…" : "Reload from file"}
    </button>
  </div>
{/if}
