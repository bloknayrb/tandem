<script lang="ts">
import type { Editor } from "@tiptap/core";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import type { OpenTab } from "../../types.js";
import {
  type FindReplaceOptions,
  getFindState,
  replaceActive,
  replaceAll,
} from "../extensions/find-replace.js";

interface CrossDocMatch {
  tabId: string;
  fileName: string;
  count: number;
  snippets: string[];
}

interface Props {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
  tabs?: OpenTab[];
  forceScope?: "doc" | "tabs";
}

let { editor, open, onClose, tabs = [], forceScope }: Props = $props();

type Scope = "doc" | "tabs";
let scope = $state<Scope>("doc");
let crossDocResults = $state<CrossDocMatch[]>([]);
let crossDocSearching = $state(false);

// Reset scope to "doc" when tabs drop to a single entry so in-doc find keeps working.
$effect(() => {
  if (tabs.length <= 1 && scope === "tabs") {
    scope = "doc";
    crossDocResults = [];
    crossDocSearching = false;
  }
});

function extractYdocText(ydoc: Y.Doc): string {
  const fragment = ydoc.getXmlFragment("default");
  const parts: string[] = [];
  function walk(node: Y.XmlElement | Y.XmlFragment | Y.XmlText) {
    if (node instanceof Y.XmlText) {
      parts.push(node.toString());
    } else {
      for (let i = 0; i < node.length; i++) {
        const child = node.get(i);
        if (child instanceof Y.XmlText || child instanceof Y.XmlElement) {
          walk(child);
        }
      }
      if (node instanceof Y.XmlElement && node.nodeName !== "text") {
        parts.push(" ");
      }
    }
  }
  walk(fragment);
  return parts.join("");
}

function searchYdoc(
  ydoc: Y.Doc,
  q: string,
  caseSensitive: boolean,
): { count: number; snippets: string[] } {
  const text = extractYdocText(ydoc);
  const needle = caseSensitive ? q : q.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  const snippets: string[] = [];
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    if (snippets.length < 3) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + needle.length + 30);
      const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
      snippets.push((start > 0 ? "…" : "") + raw + (end < text.length ? "…" : ""));
    }
    idx += needle.length;
  }
  return { count, snippets };
}

let crossDocTimer: ReturnType<typeof setTimeout> | undefined;
onDestroy(() => clearTimeout(crossDocTimer));

function scheduleCrossDocSearch(q: string, cs: boolean) {
  clearTimeout(crossDocTimer);
  if (!q) {
    crossDocResults = [];
    crossDocSearching = false;
    return;
  }
  crossDocSearching = true;
  crossDocTimer = setTimeout(() => {
    const results: CrossDocMatch[] = [];
    for (const tab of tabs) {
      if (!tab.ydoc) continue;
      const { count, snippets } = searchYdoc(tab.ydoc, q, cs);
      if (count > 0) {
        results.push({ tabId: tab.id, fileName: tab.fileName, count, snippets });
      }
    }
    crossDocResults = results;
    crossDocSearching = false;
  }, 300);
}

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

$effect(() => {
  if (!open) return;
  queryInput?.focus();
});

// Apply forceScope on the false→true open transition. Plain `let` (not $state)
// so the effect doesn't track this read; the `open` change is the only trigger.
let prevOpenForScope = false;
$effect(() => {
  const isOpening = open && !prevOpenForScope;
  prevOpenForScope = open;
  if (!isOpening || !forceScope) return;
  if (forceScope === "tabs" && tabs.length > 1) {
    scope = "tabs";
    scheduleCrossDocSearch(query, caseSensitive);
  } else {
    scope = "doc";
  }
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
  if (scope === "tabs") {
    scheduleCrossDocSearch(query, caseSensitive);
    return;
  }

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

function handleScopeChange(newScope: Scope) {
  scope = newScope;
  if (newScope === "tabs") {
    editor?.commands.findClose();
    scheduleCrossDocSearch(query, caseSensitive);
  } else {
    crossDocResults = [];
    clearTimeout(crossDocTimer);
    dispatchFind();
  }
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
    <!-- Scope pills -->
    {#if tabs.length > 1}
      <div
        data-testid="find-scope-pills"
        style="display: flex; gap: var(--tandem-space-1); align-items: center;"
      >
        <button
          data-testid="find-scope-doc"
          onclick={() => handleScopeChange("doc")}
          aria-pressed={scope === "doc"}
          style="
            padding: 2px var(--tandem-space-2); font-size: var(--tandem-text-xs);
            border: 1px solid {scope === 'doc' ? 'var(--tandem-accent-border)' : 'var(--tandem-border)'};
            border-radius: var(--tandem-r-pill);
            background: {scope === 'doc' ? 'var(--tandem-accent-bg)' : 'var(--tandem-surface)'};
            color: {scope === 'doc' ? 'var(--tandem-accent)' : 'var(--tandem-fg-muted)'};
            cursor: pointer;
          "
        >This document</button>
        <button
          data-testid="find-scope-tabs"
          onclick={() => handleScopeChange("tabs")}
          aria-pressed={scope === "tabs"}
          style="
            padding: 2px var(--tandem-space-2); font-size: var(--tandem-text-xs);
            border: 1px solid {scope === 'tabs' ? 'var(--tandem-accent-border)' : 'var(--tandem-border)'};
            border-radius: var(--tandem-r-pill);
            background: {scope === 'tabs' ? 'var(--tandem-accent-bg)' : 'var(--tandem-surface)'};
            color: {scope === 'tabs' ? 'var(--tandem-accent)' : 'var(--tandem-fg-muted)'};
            cursor: pointer;
          "
        >Open tabs</button>
      </div>
    {/if}

    <!-- Query row -->
    <div style="display: flex; gap: var(--tandem-space-2); align-items: center;">
      <input
        bind:this={queryInput}
        data-testid="find-input"
        type="text"
        placeholder="Find…"
        aria-label="Find"
        bind:value={query}
        oninput={dispatchFind}
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
        disabled={matchCount === 0 || isReplacing || scope === "tabs"}
        title={scope === "tabs" ? "Replace is not available in Open tabs mode" : undefined}
        style="
          padding: 4px 10px; font-size: var(--tandem-text-xs); cursor: pointer;
          border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
          background: var(--tandem-surface); color: var(--tandem-fg-muted);
          opacity: {matchCount === 0 || isReplacing || scope === 'tabs' ? 0.4 : 1};
        "
      >
        Replace
      </button>
      <button
        data-testid="replace-all-btn"
        onclick={handleReplaceAll}
        disabled={matchCount === 0 || isReplacing || scope === "tabs"}
        title={scope === "tabs" ? "Replace All is not available in Open tabs mode" : undefined}
        style="
          padding: 4px 10px; font-size: var(--tandem-text-xs); cursor: pointer;
          border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
          background: var(--tandem-surface); color: var(--tandem-fg-muted);
          opacity: {matchCount === 0 || isReplacing || scope === 'tabs' ? 0.4 : 1};
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

    <!-- Cross-doc results -->
    {#if scope === "tabs"}
      <div
        data-testid="find-cross-doc-results"
        style="border-top: 1px solid var(--tandem-border); padding-top: var(--tandem-space-2); display: flex; flex-direction: column; gap: var(--tandem-space-1);"
      >
        {#if crossDocSearching}
          <div style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);">Searching…</div>
        {:else if query && crossDocResults.length === 0}
          <div style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);">No matches in open tabs</div>
        {:else}
          {#each crossDocResults as result}
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <div style="font-size: var(--tandem-text-xs); color: var(--tandem-fg); font-weight: 500;">
                {result.fileName}
                <span style="color: var(--tandem-fg-subtle); font-weight: normal;">({result.count} {result.count === 1 ? 'match' : 'matches'})</span>
              </div>
              {#each result.snippets as snippet}
                <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); padding-left: var(--tandem-space-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  {snippet}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
