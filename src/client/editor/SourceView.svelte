<script lang="ts">
import { untrack } from "svelte";
import type * as Y from "yjs";
import { API_DOCUMENT_RAW, API_DOCUMENT_RELOAD } from "../../shared/api-paths.js";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { API_BASE } from "../utils/fileUpload.js";

interface Props {
  documentId: string;
  ydoc: Y.Doc;
  /**
   * In-progress source text carried over from a previous mount of this same
   * document (e.g. the user switched tabs away and back). When present it
   * overrides the freshly-fetched disk content so edits aren't lost (#1021
   * review). `undefined` → start from the disk content.
   */
  initialDraft?: string;
  /**
   * Report the current draft + dirty state up to App so it can (a) preserve the
   * text across a tab switch that unmounts this component, and (b) warn on tab
   * close / app quit. Event-driven (textarea input + commit) — deliberately NOT
   * a reactive `$effect` reading this prop, which would re-fire on every parent
   * re-render and loop.
   */
  onDraftChange: (text: string, dirty: boolean) => void;
  /** Return to the WYSIWYG editor. */
  onExit: () => void;
}

const { documentId, ydoc, initialDraft, onDraftChange, onExit }: Props = $props();

// Capture the draft ONCE at mount (untrack makes the non-reactive read
// explicit). The component is keyed on documentId by the parent, so this is the
// correct tab's draft; not reading the prop inside the fetch $effect keeps that
// effect from re-running on every keystroke — App updates `sourceDrafts` on
// input, which would otherwise change the `initialDraft` prop and retrigger a
// fetch that clobbers the live text.
const draftAtMount = untrack(() => initialDraft);

let originalMarkdown = $state("");
let currentMarkdown = $state("");
let loading = $state(true);
let saving = $state(false);
let errorMessage = $state<string | null>(null);

const dirty = $derived(!loading && currentMarkdown !== originalMarkdown);

// Mirror the annotation-map size into reactive $state via a Y.Map observer.
// A plain `$derived(ydoc.getMap(...).size)` would NOT update — Yjs mutations
// don't notify Svelte's reactivity graph — leaving the clear-on-commit warning
// stale if Claude adds/removes annotations while source view is open.
let annotationCount = $state(0);
$effect(() => {
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const update = (): void => {
    annotationCount = map.size;
  };
  update();
  map.observe(update);
  return () => map.unobserve(update);
});

// Fetch the literal markdown source on mount / when the target doc changes.
$effect(() => {
  const id = documentId;
  let cancelled = false;
  loading = true;
  errorMessage = null;
  (async () => {
    try {
      const res = await fetch(
        `${API_BASE}${API_DOCUMENT_RAW}?documentId=${encodeURIComponent(id)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? res.statusText);
      }
      const json = (await res.json()) as { markdown?: string };
      if (cancelled) return;
      originalMarkdown = json.markdown ?? "";
      // Restore an in-progress draft (tab-switch round-trip) over the disk
      // content; otherwise start from disk. Uses the mount-captured value so
      // this effect never re-runs when App rewrites the live draft.
      currentMarkdown = draftAtMount ?? originalMarkdown;
    } catch (err) {
      if (cancelled) return;
      errorMessage = err instanceof Error ? err.message : "Failed to load markdown source.";
    } finally {
      if (!cancelled) loading = false;
    }
  })();
  return () => {
    cancelled = true;
  };
});

/**
 * Persist the edited markdown back into the Y.Doc (replaces content, clears
 * annotations). Returns true on success. On failure, surfaces an inline error
 * and keeps the user in source view with their edits intact.
 */
async function commit(): Promise<boolean> {
  saving = true;
  errorMessage = null;
  try {
    const res = await fetch(`${API_BASE}${API_DOCUMENT_RELOAD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, markdown: currentMarkdown }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? res.statusText);
    }
    originalMarkdown = currentMarkdown;
    // Committed content now matches disk — clear the draft/dirty flag in App.
    onDraftChange(currentMarkdown, false);
    return true;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Failed to apply markdown changes.";
    return false;
  } finally {
    saving = false;
  }
}

/** Report a textarea edit up to App for cross-switch preservation + close/quit warning. */
function handleInput(e: Event): void {
  const value = (e.target as HTMLTextAreaElement).value;
  onDraftChange(value, value !== originalMarkdown);
}

async function handleExit(): Promise<void> {
  if (dirty) {
    const ok = await commit();
    if (!ok) return; // stay in source view so edits aren't lost
  }
  onExit();
}

async function handleKeydown(e: KeyboardEvent): Promise<void> {
  // Ctrl/Cmd+S commits the source edit instead of saving stale Y.Doc content.
  // stopPropagation is load-bearing: without it the event bubbles to App's
  // window-level keydown listener, whose `save` branch has no form-field guard
  // and would `triggerSave()` the STALE Y.Doc to disk, racing this commit
  // (#1021 review must-fix). This handler runs first (bubble phase, target),
  // so stopping propagation here keeps the global save from ever firing.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.stopPropagation();
    if (dirty && !saving) await commit();
  }
}

async function copyToClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText(currentMarkdown);
  } catch {
    // Clipboard can be unavailable (permissions / insecure context) — non-fatal.
  }
}
</script>

<div class="source-view" data-testid="source-view-container">
  <div class="source-view-toolbar">
    <button
      type="button"
      class="source-view-btn source-view-exit"
      data-testid="source-view-exit-btn"
      disabled={saving}
      onclick={handleExit}
    >
      ← WYSIWYG
    </button>
    <span class="source-view-title">Markdown source</span>
    <button
      type="button"
      class="source-view-btn"
      data-testid="source-view-copy-btn"
      disabled={loading}
      onclick={copyToClipboard}
    >
      Copy
    </button>
  </div>

  {#if annotationCount > 0}
    <div class="source-view-warning" data-testid="source-view-annotation-warning" role="status">
      Editing the source clears this document's {annotationCount} annotation{annotationCount === 1
        ? ""
        : "s"} when you return to the editor.
    </div>
  {/if}

  {#if errorMessage}
    <div class="source-view-error" data-testid="source-view-error" role="alert">
      {errorMessage}
    </div>
  {/if}

  {#if loading}
    <div class="source-view-loading">Loading source…</div>
  {:else}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      class="source-view-textarea"
      data-testid="source-view-textarea"
      bind:value={currentMarkdown}
      oninput={handleInput}
      onkeydown={handleKeydown}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label="Markdown source"
    ></textarea>
  {/if}
</div>

<style>
  .source-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: var(--tandem-space-2);
  }

  .source-view-toolbar {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-3);
  }

  .source-view-title {
    flex: 1;
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-subtle);
  }

  .source-view-btn {
    font-size: var(--tandem-text-sm);
    padding: var(--tandem-space-1) var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    cursor: pointer;
  }

  .source-view-btn:hover:not(:disabled) {
    background: var(--tandem-surface-hover);
  }

  .source-view-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .source-view-exit {
    font-weight: 600;
  }

  .source-view-warning {
    font-size: var(--tandem-text-sm);
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border: 1px solid var(--tandem-warning-border);
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-radius: var(--tandem-r-2);
  }

  .source-view-error {
    font-size: var(--tandem-text-sm);
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border: 1px solid var(--tandem-error-border);
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-radius: var(--tandem-r-2);
  }

  .source-view-loading {
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-sm);
  }

  .source-view-textarea {
    flex: 1;
    width: 100%;
    resize: none;
    box-sizing: border-box;
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-sm);
    line-height: 1.6;
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }

  .source-view-textarea:focus {
    outline: 2px solid var(--tandem-accent);
    outline-offset: -2px;
  }
</style>
