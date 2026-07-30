<script lang="ts">
import type * as Y from "yjs";
import { API_EXTERNAL_CONFLICT_RESOLVE } from "../../shared/api-paths";
import {
  SAVEABLE_FORMATS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
} from "../../shared/constants";
import type { ExternalConflictState } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";
import "./tandem-banner.css";

/**
 * Keep-vs-reload prompt for external conflicts (#1069; every format since
 * #1238 — the Y.Doc is the only copy of an unsaved edit whatever the format).
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
  /** Document format, so the copy doesn't promise a save the format can't do. */
  format: string;
}

const { ydoc, documentId, fileName, format }: Props = $props();

/**
 * Formats with NO path back to disk — the server refuses every save for them.
 * Keeping edits on one of these means keeping them in this session only, which
 * the default copy would otherwise misdescribe as "your next save overwrites
 * the disk changes" (#1238). Reads the shared set the server gates on rather
 * than re-listing formats here, which would be a second source of truth.
 */
const cannotSave = $derived(!SAVEABLE_FORMATS.has(format));

let conflict = $state<ExternalConflictState | null>(null);
let pending = $state<"keep" | "reload" | null>(null);
let error = $state<string | null>(null);

$effect(() => {
  // Track the ydoc prop — re-observe when the active tab's doc changes.
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
  const read = () => {
    const next = (meta.get(Y_MAP_EXTERNAL_CONFLICT) as ExternalConflictState | undefined) ?? null;
    // Drop a stale failure when the conflict itself goes away, or a resolve
    // that errored once would re-attach its message to the NEXT conflict on
    // the same document (the banner unmounts and remounts, but `error` is
    // component state and only the ydoc-swap cleanup clears it).
    if (next === null) error = null;
    conflict = next;
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
    return cannotSave
      ? `${fileName} changed on disk while you have unsaved edits. Tandem can't write this file type back to disk, so keeping your edits keeps them in this session only — the file itself will still hold the disk version. Reloading discards your unsaved edits.`
      : `${fileName} changed on disk while you have unsaved edits. Keeping your edits means your next save overwrites the disk changes; reloading discards your unsaved edits.`;
  }
  if (cannotSave) {
    return `Unsaved edits for ${fileName} were restored from your last session. Tandem can't write this file type back to disk, so keeping them keeps them in this session only. Reload to start fresh from the file on disk (discards them).`;
  }
  return conflict.diskChanged
    ? `Unsaved edits for ${fileName} were restored from your last session, but the file also changed on disk. Keep your restored edits, or reload the file from disk (discards them)?`
    : `Unsaved edits for ${fileName} were restored from your last session. Keep them, or reload fresh from the file on disk (discards them)?`;
});

async function resolve(choice: "keep" | "reload") {
  if (pending) return;
  // Pin the document this request belongs to. App.svelte remounts this
  // component per tab, so today the prop can't change mid-flight — but the
  // component accepts a swappable `ydoc`/`documentId`, and every write below
  // happens AFTER an await. Without the pin, a resolve for document A that
  // settles after a switch would print A's failure inside B's banner and clear
  // B's `pending`, re-enabling its buttons with B's own request still in flight.
  const forDoc = documentId;
  pending = choice;
  error = null;
  try {
    const res = await fetch(`${API_BASE}${API_EXTERNAL_CONFLICT_RESOLVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: forDoc, choice }),
    });
    if (!res.ok && forDoc === documentId) {
      const body = await res.json().catch(() => null);
      error = body?.message ?? `Request failed (HTTP ${res.status}).`;
    }
    // On success the server clears the meta flag — the observer hides the banner.
  } catch {
    if (forDoc === documentId) error = "Could not reach the server.";
  } finally {
    if (forDoc === documentId) pending = null;
  }
}
</script>

{#if conflict}
  <div
    class="tandem-banner tandem-banner--warning"
    role="status"
    aria-live="polite"
    data-testid="external-conflict-banner"
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
      data-testid="external-conflict-keep-btn"
      onclick={() => resolve("keep")}
      disabled={pending !== null}
    >
      {pending === "keep" ? "Keeping…" : "Keep my edits"}
    </button>
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="external-conflict-reload-btn"
      onclick={() => resolve("reload")}
      disabled={pending !== null}
    >
      {pending === "reload" ? "Reloading…" : "Reload from file"}
    </button>
  </div>
{/if}
