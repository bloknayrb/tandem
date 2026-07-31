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
 *
 * `tandem-banner--sticky` (review finding): this banner mounts inside
 * `.editor-scroll`, a normal-flow position like the rest of the document body.
 * Widened from `.docx`-only (#1069, rare external rewrites) to `.md`/`.txt`
 * (#1238, routinely rewritten by git/tooling/other editors while open) with
 * autosave now unconditionally blocked while a conflict is pending, a user
 * scrolled into a long document would otherwise have no persistent signal that
 * saving has silently stopped. Sticky-positions just this banner, not the
 * shared `.tandem-banner--warning` family FidelityReportBanner also uses.
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
  // Plain closure variable, NOT $state: `read()` runs inside this $effect, so
  // reading the `conflict` $state here (to detect an identity change) would
  // make the effect read AND write the same state in one execution —
  // `effect_update_depth_exceeded`. Tracking the last-seen id in an untracked
  // local sidesteps that; `conflict` itself stays effect-write-only exactly
  // like before this change.
  let lastDetectedAt: number | undefined;
  const read = () => {
    const next = (meta.get(Y_MAP_EXTERNAL_CONFLICT) as ExternalConflictState | undefined) ?? null;
    // Reset on any identity change, not just the "conflict cleared" (→null)
    // case (review finding): `{#key activeTab.id}` in App.svelte and the
    // `forDoc` pin in resolve() only guard CROSS-document leakage. On the SAME
    // document, a slow resolve() for conflict A can still be in flight when
    // the server clears A and raises a fresh conflict B — without this, B's
    // banner would inherit A's stale `pending`/`error` (wrongly-disabled
    // buttons, or A's eventual failure text attached to B). `detectedAt` is a
    // stable per-episode id (a carried flag is re-raised with its ORIGINAL
    // detectedAt, but that path only fires for a document not currently open
    // — see file-opener.ts's openFileByPath — so it can't collide with a live
    // banner's in-flight request).
    if (next?.detectedAt !== lastDetectedAt) {
      error = null;
      pending = null;
    }
    lastDetectedAt = next?.detectedAt;
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
  // Pin the document AND the conflict episode this request belongs to. The
  // document pin (`forDoc`) guards cross-document leakage — App.svelte remounts
  // this component per tab, so today the prop can't change mid-flight, but the
  // component accepts a swappable `ydoc`/`documentId`, and every write below
  // happens AFTER an await, so a resolve for document A that settles after a
  // switch must not print A's failure inside B's banner. The conflict pin
  // (`forConflict`) guards the narrower same-document case (review finding): A
  // slow resolve for conflict A can still be in flight when the server clears
  // A and raises a fresh conflict B on the SAME document — without this, B's
  // banner would inherit A's stale `pending`/`error`.
  const forDoc = documentId;
  const forConflict = conflict?.detectedAt;
  pending = choice;
  error = null;
  try {
    const res = await fetch(`${API_BASE}${API_EXTERNAL_CONFLICT_RESOLVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: forDoc, choice }),
    });
    const stillCurrent = forDoc === documentId && forConflict === conflict?.detectedAt;
    if (!res.ok && stillCurrent) {
      const body = await res.json().catch(() => null);
      error = body?.message ?? `Request failed (HTTP ${res.status}).`;
    }
    // On success the server clears the meta flag — the observer hides the banner.
  } catch {
    if (forDoc === documentId && forConflict === conflict?.detectedAt) {
      error = "Could not reach the server.";
    }
  } finally {
    if (forDoc === documentId && forConflict === conflict?.detectedAt) pending = null;
  }
}
</script>

{#if conflict}
  <div
    class="tandem-banner tandem-banner--warning tandem-banner--sticky"
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
