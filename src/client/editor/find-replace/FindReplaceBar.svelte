<script lang="ts">
import type { Editor } from "@tiptap/core";
import { onMount } from "svelte";
import {
  type FindReplaceOptions,
  getFindState,
  replaceActive,
  replaceAll,
} from "../extensions/find-replace.js";

interface Props {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
}

let { editor, open, onClose }: Props = $props();

let query = $state("");
let replaceText = $state("");
let caseSensitive = $state(false);
let wholeWord = $state(false);
let regexMode = $state(false);
let regexError = $state<string | null>(null);
let isReplacing = $state(false);
let replaceProgress = $state<{ replaced: number; total: number } | null>(null);
let partialWarning = $state<string | null>(null);

// Tick counter — bump to force re-read of plugin state
let tick = $state(0);

const findState = $derived.by(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  tick;
  return editor ? getFindState(editor.state) : undefined;
});

const matchCount = $derived(findState?.matches.length ?? 0);
const activeIndex = $derived(findState?.activeIndex ?? -1);

let queryInput = $state<HTMLInputElement | null>(null);

onMount(() => {
  if (open) queryInput?.focus();
});

$effect(() => {
  if (!open) return;
  queryInput?.focus();
});

$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;

  const bumpTick = () => tick++;
  ed.on("update", bumpTick);
  ed.on("selectionUpdate", bumpTick);
  return () => {
    if (!ed.isDestroyed) {
      ed.off("update", bumpTick);
      ed.off("selectionUpdate", bumpTick);
    }
  };
});

function dispatchFind() {
  const ed = editor;
  if (!ed || !query) {
    regexError = null;
    ed?.commands.findClose();
    return;
  }

  if (regexMode) {
    try {
      new RegExp(query);
      regexError = null;
    } catch (e) {
      regexError = e instanceof Error ? e.message : "Invalid regex";
      return;
    }
  } else {
    regexError = null;
  }

  const opts: FindReplaceOptions = { query, caseSensitive, wholeWord, regexMode };
  ed.commands.find(opts);
}

function handleQueryInput() {
  dispatchFind();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      editor?.commands.findPrev();
    } else {
      editor?.commands.findNext();
    }
    return;
  }
  if (e.key === "Escape") {
    close();
  }
}

function close() {
  editor?.commands.findClose();
  onClose();
}

async function handleReplaceAll() {
  const ed = editor;
  if (!ed || !query || isReplacing) return;

  const currentCount = matchCount;
  if (currentCount > 500) {
    const confirmed = window.confirm(
      `Replace all ${currentCount} occurrences? This cannot be undone as a single action.`,
    );
    if (!confirmed) return;
  }

  isReplacing = true;
  partialWarning = null;
  replaceProgress = { replaced: 0, total: currentCount };

  const { replaced, partial } = await replaceAll(ed.view, replaceText, (r, t) => {
    replaceProgress = { replaced: r, total: t };
  });

  replaceProgress = null;
  isReplacing = false;

  if (partial) {
    partialWarning = `Replaced ${replaced} of ${currentCount}; re-run to continue`;
  }
}
</script>

{#if open}
  <div
    data-testid="find-replace-bar"
    role="dialog"
    tabindex="-1"
    aria-modal="false"
    aria-label="Find and replace"
    style="
      position: absolute; bottom: 0; right: 0;
      background: var(--tandem-surface); border: 1px solid var(--tandem-border);
      border-radius: var(--tandem-r-3) var(--tandem-r-3) 0 0;
      padding: var(--tandem-space-3) var(--tandem-space-4);
      box-shadow: var(--tandem-shadow-3);
      z-index: var(--tandem-z-overlay, 200);
      min-width: 320px; max-width: 480px;
      display: flex; flex-direction: column; gap: var(--tandem-space-2);
    "
    onkeydown={handleKeydown}
  >
    <!-- Query row -->
    <div style="display: flex; gap: var(--tandem-space-2); align-items: center;">
      <input
        bind:this={queryInput}
        data-testid="find-input"
        type="text"
        placeholder="Find…"
        aria-label="Find"
        bind:value={query}
        oninput={handleQueryInput}
        style="
          flex: 1; padding: 4px 8px; font-size: var(--tandem-text-sm);
          border: 1px solid {regexError ? 'var(--tandem-error)' : 'var(--tandem-border)'};
          border-radius: var(--tandem-r-2); background: var(--tandem-surface);
          color: var(--tandem-fg); outline: none;
        "
      />
      <!-- Match count -->
      <span
        data-testid="find-match-count"
        style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); white-space: nowrap; min-width: 48px; text-align: right;"
      >
        {#if query}
          {matchCount === 0 ? "No matches" : `${activeIndex + 1} / ${matchCount}`}
        {/if}
      </span>
      <!-- Prev / Next -->
      <button
        data-testid="find-prev-btn"
        onclick={() => editor?.commands.findPrev()}
        disabled={matchCount === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        style="background: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); padding: 2px 6px; cursor: pointer; font-size: 12px; color: var(--tandem-fg-muted); opacity: {matchCount === 0 ? 0.4 : 1};"
      >
        ↑
      </button>
      <button
        data-testid="find-next-btn"
        onclick={() => editor?.commands.findNext()}
        disabled={matchCount === 0}
        title="Next match (Enter)"
        aria-label="Next match"
        style="background: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); padding: 2px 6px; cursor: pointer; font-size: 12px; color: var(--tandem-fg-muted); opacity: {matchCount === 0 ? 0.4 : 1};"
      >
        ↓
      </button>
      <!-- Close -->
      <button
        data-testid="find-close-btn"
        onclick={close}
        title="Close (Esc)"
        aria-label="Close find bar"
        style="background: none; border: none; cursor: pointer; font-size: 16px; color: var(--tandem-fg-muted); padding: 0 2px; line-height: 1;"
      >
        ×
      </button>
    </div>

    {#if regexError}
      <div style="font-size: var(--tandem-text-xs); color: var(--tandem-error-fg);" role="alert">
        {regexError}
      </div>
    {/if}

    <!-- Options -->
    <div style="display: flex; gap: var(--tandem-space-3); align-items: center;">
      <label style="display: flex; align-items: center; gap: 4px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); cursor: pointer; user-select: none;">
        <input
          data-testid="find-case-toggle"
          type="checkbox"
          bind:checked={caseSensitive}
          onchange={dispatchFind}
        />
        Aa
      </label>
      <label style="display: flex; align-items: center; gap: 4px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); cursor: pointer; user-select: none;">
        <input
          data-testid="find-word-toggle"
          type="checkbox"
          bind:checked={wholeWord}
          onchange={dispatchFind}
        />
        \b
      </label>
      <label style="display: flex; align-items: center; gap: 4px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); cursor: pointer; user-select: none;">
        <input
          data-testid="find-regex-toggle"
          type="checkbox"
          bind:checked={regexMode}
          onchange={dispatchFind}
        />
        .*
      </label>
    </div>

    <!-- Replace row -->
    <div style="display: flex; gap: var(--tandem-space-2); align-items: center;">
      <input
        data-testid="replace-input"
        type="text"
        placeholder="Replace with…"
        aria-label="Replace with"
        bind:value={replaceText}
        style="
          flex: 1; padding: 4px 8px; font-size: var(--tandem-text-sm);
          border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
          background: var(--tandem-surface); color: var(--tandem-fg); outline: none;
        "
      />
      <button
        data-testid="replace-btn"
        onclick={() => { if (editor) { replaceActive(editor.view, replaceText); tick++; } }}
        disabled={matchCount === 0 || isReplacing}
        style="
          padding: 4px 10px; font-size: var(--tandem-text-xs); cursor: pointer;
          border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
          background: var(--tandem-surface); color: var(--tandem-fg-muted);
          opacity: {matchCount === 0 || isReplacing ? 0.4 : 1};
        "
      >
        Replace
      </button>
      <button
        data-testid="replace-all-btn"
        onclick={handleReplaceAll}
        disabled={matchCount === 0 || isReplacing}
        style="
          padding: 4px 10px; font-size: var(--tandem-text-xs); cursor: pointer;
          border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
          background: var(--tandem-surface); color: var(--tandem-fg-muted);
          opacity: {matchCount === 0 || isReplacing ? 0.4 : 1};
        "
      >
        {#if isReplacing && replaceProgress}
          {replaceProgress.replaced}/{replaceProgress.total}
        {:else}
          All
        {/if}
      </button>
    </div>

    {#if partialWarning}
      <div
        style="font-size: var(--tandem-text-xs); color: var(--tandem-warning-fg); padding: 2px 0;"
        role="status"
      >
        {partialWarning}
      </div>
    {/if}
  </div>
{/if}
