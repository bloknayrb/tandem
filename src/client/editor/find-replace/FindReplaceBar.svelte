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

// Replace row collapses by default (B4). Pure UI state driven by user events —
// toggled imperatively in handlers, never via $effect (would risk the tick
// cascade documented in Editor.svelte's setEditable/bumpTick guard).
let replaceOpen = $state(false);

// Tick counter — bump to force re-read of plugin state
let tick = $state(0);

const findState = $derived.by(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  tick;
  return editor ? getFindState(editor.state) : undefined;
});

const matchCount = $derived(findState?.matches.length ?? 0);
const activeIndex = $derived(findState?.activeIndex ?? -1);

// No-match tint applies only to in-document find (cross-tab uses its own panel).
const noMatch = $derived(scope === "doc" && !!query && matchCount === 0 && !regexError);
const countLabel = $derived.by(() => {
  if (scope !== "doc" || !query) return "";
  if (regexError) return "error";
  if (matchCount === 0) return "0 matches";
  return `${activeIndex + 1} / ${matchCount}`;
});

let queryInput = $state<HTMLInputElement | null>(null);
let replaceInput = $state<HTMLInputElement | null>(null);

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
  // Only subscribe while the bar is open: the match count is rendered only
  // inside `{#if open}`, so bumping on every editor transaction while the bar
  // is closed is pure waste (this component stays mounted in editorColumn).
  if (!open) return;
  const ed = editor;
  if (!ed || ed.isDestroyed) return;

  // Bump on `transaction` — NOT just `update`/`selectionUpdate`. find/findNext/
  // findPrev dispatch META-ONLY transactions that change neither the doc nor the
  // selection, so those two events never fire and the match count freezes at 0
  // (pre-existing bug, made loud by the no-match tint). `transaction` fires for
  // every transaction (a superset) and tick++ dispatches no PM transaction itself,
  // so there is no feedback loop with Editor.svelte's setEditable/readOnly guard.
  const bumpTick = () => tick++;
  ed.on("transaction", bumpTick);
  return () => {
    if (!ed.isDestroyed) {
      ed.off("transaction", bumpTick);
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

// Imperative toggle (no $effect) — focus the replace input after it un-hides.
function toggleReplace() {
  replaceOpen = !replaceOpen;
  if (replaceOpen) {
    requestAnimationFrame(() => replaceInput?.focus());
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
    // Two-stage: collapse an open replace row first, then close. Stop the event
    // so it never bubbles to App-level Escape handlers (which would close the
    // bar outright and make the first stage invisible).
    e.preventDefault();
    e.stopPropagation();
    if (replaceOpen) {
      replaceOpen = false;
      queryInput?.focus();
      return;
    }
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
  <!-- Anchor: floats top-right of the editor column (a non-scrolling wrapper in
       App.svelte is the offset parent, so the panel never scrolls with the doc).
       Slide-in-from-above motion shared with the new-tab / slash-menu family. -->
  <div class="fr-anchor">
    <div
      data-testid="find-replace-bar"
      role="dialog"
      tabindex="-1"
      aria-modal="false"
      aria-label="Find and replace"
      class="fr"
      class:no-match={noMatch}
      onkeydown={handleKeydown}
    >
      <!-- Find row -->
      <div class="fr-find">
        <span class="ic" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        </span>
        <input
          bind:this={queryInput}
          data-testid="find-input"
          type="text"
          placeholder="Find in document…"
          aria-label="Find in document"
          autocomplete="off"
          bind:value={query}
          oninput={dispatchFind}
        />
        <span
          data-testid="find-match-count"
          class="count"
          class:no-match={noMatch}
          class:err={!!regexError}
        >{countLabel}</span>
        <span class="esc" aria-hidden="true">Esc</span>
      </div>

      <!-- Controls strip: nav + toggles + expand/close -->
      <div class="fr-controls">
        <div class="nav-group">
          <button
            data-testid="find-prev-btn"
            class="fr-nav"
            onclick={() => editor?.commands.findPrev()}
            disabled={matchCount === 0}
            title="Previous match (⇧↵)"
            aria-label="Previous match"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button
            data-testid="find-next-btn"
            class="fr-nav"
            onclick={() => editor?.commands.findNext()}
            disabled={matchCount === 0}
            title="Next match (↵)"
            aria-label="Next match"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        <div class="toggles">
          <button
            data-testid="find-case-toggle"
            class="fr-toggle"
            class:on={caseSensitive}
            aria-pressed={caseSensitive}
            title="Case sensitive"
            onclick={() => { caseSensitive = !caseSensitive; dispatchFind(); }}
          >Aa</button>
          <button
            data-testid="find-word-toggle"
            class="fr-toggle"
            class:on={wholeWord}
            aria-pressed={wholeWord}
            title="Whole word"
            onclick={() => { wholeWord = !wholeWord; dispatchFind(); }}
          >\b</button>
          <button
            data-testid="find-regex-toggle"
            class="fr-toggle"
            class:on={regexMode}
            aria-pressed={regexMode}
            title="Regular expression"
            onclick={() => { regexMode = !regexMode; dispatchFind(); }}
          >.*</button>
        </div>
        <span class="spacer"></span>
        <button
          data-testid="find-replace-expand-btn"
          class="fr-expand"
          class:on={replaceOpen}
          aria-label="Toggle replace row"
          aria-expanded={replaceOpen}
          title="Toggle replace"
          onclick={toggleReplace}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <button
          data-testid="find-close-btn"
          class="fr-close"
          onclick={close}
          title="Close (Esc)"
          aria-label="Close find bar"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M6 18L18 6" /></svg>
        </button>
      </div>

      <!-- Replace row (always mounted; hidden via attribute so the input ref stays bound) -->
      <div class="fr-replace" hidden={!replaceOpen}>
        <span class="ic" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15l3 3 3-3" /><path d="M12 12v6" /></svg>
        </span>
        <input
          bind:this={replaceInput}
          data-testid="replace-input"
          type="text"
          placeholder="Replace with…"
          aria-label="Replace with"
          autocomplete="off"
          bind:value={replaceText}
        />
        <button
          data-testid="replace-btn"
          class="fr-replace-btn"
          onclick={() => { if (editor) { replaceActive(editor.view, replaceText); tick++; } }}
          disabled={matchCount === 0 || isReplacing || scope === "tabs"}
          title={scope === "tabs" ? "Replace is not available in Open tabs mode" : undefined}
        >
          Replace
        </button>
        <button
          data-testid="replace-all-btn"
          class="fr-replace-btn primary"
          onclick={handleReplaceAll}
          disabled={matchCount === 0 || isReplacing || scope === "tabs"}
          title={scope === "tabs" ? "Replace All is not available in Open tabs mode" : undefined}
        >
          {#if isReplacing && replaceProgress}
            {replaceProgress.replaced}/{replaceProgress.total}
          {:else}
            All
          {/if}
        </button>
      </div>

      <!-- Scope pills — only with 2+ tabs open -->
      {#if tabs.length > 1}
        <div data-testid="find-scope-pills" class="fr-scope">
          <span class="label">Scope</span>
          <button
            data-testid="find-scope-doc"
            class="fr-scope-pill"
            class:on={scope === "doc"}
            onclick={() => handleScopeChange("doc")}
            aria-pressed={scope === "doc"}
          >This document</button>
          <button
            data-testid="find-scope-tabs"
            class="fr-scope-pill"
            class:on={scope === "tabs"}
            onclick={() => handleScopeChange("tabs")}
            aria-pressed={scope === "tabs"}
          >Open tabs</button>
        </div>
      {/if}

      <!-- Regex error strip (find row also surfaces "error" in the count) -->
      {#if regexError}
        <div class="fr-msg error" role="alert">
          <span class="msg-ic" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86l-8.16 14.14A2 2 0 0 0 3.84 21h16.32a2 2 0 0 0 1.71-3l-8.16-14.14a2 2 0 0 0-3.42 0z" /></svg>
          </span>
          <span>{regexError}</span>
        </div>
      {/if}

      <!-- Partial replace-all warning -->
      {#if partialWarning}
        <div class="fr-msg warning" role="status">
          {partialWarning}
        </div>
      {/if}

      <!-- Cross-doc results (kept in-panel; restyled to fit B4) -->
      {#if scope === "tabs"}
        <div data-testid="find-cross-doc-results" class="fr-xdoc">
          {#if crossDocSearching}
            <div class="fr-xdoc-status">Searching…</div>
          {:else if query && crossDocResults.length === 0}
            <div class="fr-xdoc-status">No matches in open tabs</div>
          {:else}
            {#each crossDocResults as result}
              <div class="fr-xdoc-row">
                <div class="fr-xdoc-name">
                  {result.fileName}
                  <span class="fr-xdoc-count">({result.count} {result.count === 1 ? 'match' : 'matches'})</span>
                </div>
                {#each result.snippets as snippet}
                  <div class="fr-xdoc-snip">
                    {snippet}
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      <!-- Footer: mono keyboard legend on a sunk strip -->
      <div class="fr-footer">
        <span class="kgrp"><span class="key">↵</span>next</span>
        <span class="kgrp"><span class="key">⇧</span><span class="key">↵</span>prev</span>
        <span class="spacer"></span>
        <span class="kgrp">Esc to close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* B4 — Find & Replace. Floating panel anchored top-right of the editor
     column (the App.svelte wrapper is the non-scrolling offset parent). Same
     chrome family as the new-tab / slash menus: surface card, hairline border,
     soft shadow, mono keyboard legend at the foot. */
  .fr-anchor {
    position: absolute;
    top: 8px;
    right: 12px;
    z-index: var(--tandem-z-overlay, 200);
    transform-origin: top right;
    animation: fr-pop-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes fr-pop-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.985); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fr-anchor { animation: none; }
  }

  .fr {
    width: 440px;
    max-width: calc(100% - 24px);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-2);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ── Find row: borderless input on the panel surface ── */
  .fr-find {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    padding: 10px 12px 10px 14px;
    background: var(--tandem-surface);
  }
  .fr-find .ic {
    color: var(--tandem-fg-faint);
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
  }
  .fr-find input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg);
    padding: 0;
  }
  .fr-find input::placeholder {
    color: var(--tandem-fg-faint);
  }
  .count {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .count.no-match,
  .count.err {
    color: var(--tandem-error-fg-strong);
  }
  .esc {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    padding: 1px 6px;
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
    flex-shrink: 0;
  }

  /* No-match: tint the find-row strip rather than a separate message. */
  .fr.no-match .fr-find {
    background: var(--tandem-error-bg);
  }
  .fr.no-match .fr-find input {
    color: var(--tandem-error-fg-strong);
  }
  .fr.no-match .fr-find input::placeholder {
    color: var(--tandem-error-fg-strong);
    opacity: 0.5;
  }

  /* ── Controls strip: nav + toggles on a quieter surface ── */
  .fr-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 6px 10px;
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
  }
  .nav-group {
    display: inline-flex;
    gap: 2px;
  }
  .fr-nav {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-3);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background 100ms, color 100ms;
  }
  .fr-nav:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .fr-nav:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .toggles {
    display: inline-flex;
    gap: 2px;
    margin-left: 4px;
  }
  .fr-toggle {
    height: 24px;
    min-width: 28px;
    padding: 0 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-3);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-xs);
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: background 100ms, color 100ms, border-color 100ms;
    display: inline-grid;
    place-items: center;
  }
  .fr-toggle:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .fr-toggle.on {
    background: var(--tandem-accent-bg);
    border-color: var(--tandem-accent-border);
    color: var(--tandem-accent-fg-strong);
  }

  .spacer {
    flex: 1;
  }
  .fr-expand,
  .fr-close {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--tandem-fg-faint);
    border-radius: var(--tandem-r-3);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background 100ms, color 100ms;
    flex-shrink: 0;
  }
  .fr-expand:hover,
  .fr-close:hover,
  .fr-expand:focus-visible,
  .fr-close:focus-visible {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    outline: none;
  }
  .fr-expand.on {
    color: var(--tandem-accent-fg-strong);
  }
  .fr-expand svg {
    transition: transform 150ms;
  }
  .fr-expand.on svg {
    transform: rotate(180deg);
  }

  /* ── Replace row ── */
  .fr-replace {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    padding: 10px 12px 10px 14px;
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
  }
  .fr-replace[hidden] {
    display: none;
  }
  .fr-replace .ic {
    color: var(--tandem-fg-faint);
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
  }
  .fr-replace input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg);
    padding: 0;
  }
  .fr-replace input::placeholder {
    color: var(--tandem-fg-faint);
  }
  .fr-replace-btn {
    height: 24px;
    padding: 0 10px;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    font-weight: 500;
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-border);
    background: transparent;
    color: var(--tandem-fg-muted);
    cursor: pointer;
    transition: background 100ms, color 100ms, border-color 100ms;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .fr-replace-btn:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    border-color: var(--tandem-border-strong);
  }
  .fr-replace-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .fr-replace-btn.primary {
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    border-color: transparent;
  }
  .fr-replace-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
    background: var(--tandem-accent);
  }

  /* ── Scope row ── */
  .fr-scope {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
  }
  .fr-scope .label {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint);
    margin-right: 4px;
  }
  .fr-scope-pill {
    height: 22px;
    padding: 0 10px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-border);
    background: transparent;
    color: var(--tandem-fg-muted);
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-xs);
    cursor: pointer;
    transition: background 100ms, color 100ms, border-color 100ms;
  }
  .fr-scope-pill:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .fr-scope-pill.on {
    background: var(--tandem-accent-bg);
    border-color: var(--tandem-accent-border);
    color: var(--tandem-accent-fg-strong);
  }

  /* ── Inline message strips (regex error / partial-replace warning) ── */
  .fr-msg {
    padding: 8px 14px;
    font-size: var(--tandem-text-xs);
    border-top: 1px solid var(--tandem-border);
    font-family: var(--tandem-font-sans);
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: var(--tandem-space-2);
  }
  .fr-msg.error {
    color: var(--tandem-error-fg-strong);
    background: var(--tandem-error-bg);
  }
  .fr-msg.warning {
    color: var(--tandem-warning-fg);
    background: var(--tandem-warning-bg);
  }
  .fr-msg .msg-ic {
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* ── Cross-doc results panel ── */
  .fr-xdoc {
    border-top: 1px solid var(--tandem-border);
    padding: var(--tandem-space-2) 14px;
    background: var(--tandem-surface-muted);
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-1);
    max-height: 220px;
    overflow-y: auto;
  }
  .fr-xdoc-status {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-faint);
  }
  .fr-xdoc-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fr-xdoc-name {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg);
    font-weight: 500;
  }
  .fr-xdoc-count {
    color: var(--tandem-fg-faint);
    font-weight: normal;
  }
  .fr-xdoc-snip {
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-subtle);
    padding-left: var(--tandem-space-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Footer: mono key legend on a sunk strip ── */
  .fr-footer {
    padding: 7px 14px;
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface-sunk);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    display: flex;
    align-items: center;
    gap: var(--tandem-space-3);
  }
  .fr-footer .kgrp {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .fr-footer .key {
    padding: 1px 5px;
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    color: var(--tandem-fg-muted);
    min-width: 14px;
    text-align: center;
  }
</style>
