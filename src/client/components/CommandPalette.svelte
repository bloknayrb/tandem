<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection } from "prosemirror-state";
import { onMount } from "svelte";
import type { Annotation } from "../../shared/types.js";
import { type Action, getActionsMap } from "../actions/registry.svelte.js";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { STATIC_SHORTCUT_ROWS } from "../actions/static-shortcuts.js";
import { walkHeadings } from "../utils/headings.js";

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onClose: () => void;
  editor?: TiptapEditor | null;
  annotations?: Annotation[];
  onFocusAnnotation?: (id: string) => void;
}

let { open, onClose, editor = null, annotations = [], onFocusAnnotation }: Props = $props();

// ---------------------------------------------------------------------------
// Query state
// ---------------------------------------------------------------------------

let query = $state("");
let selectedIndex = $state(0);
let inputEl = $state<HTMLInputElement | null>(null);

// Detect routing prefix
const PREFIXES = ["#", "@", "?", ">"] as const;
type Prefix = (typeof PREFIXES)[number];
const activePrefix = $derived<Prefix | null>(PREFIXES.find((p) => query.startsWith(p)) ?? null);
const searchText = $derived((activePrefix ? query.slice(1) : query).trim().toLowerCase());

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type ActionResult = { kind: "action"; id: string; action: Action };
type HeadingResult = { kind: "heading"; id: string; text: string; level: number; pos: number };
type AnnotationResult = {
  kind: "annotation";
  id: string;
  label: string;
  snippet: string;
  annotationType: string;
};
type ShortcutResult = {
  kind: "shortcut";
  id: string;
  keys: string;
  description: string;
  group: string;
};

type PaletteResult = ActionResult | HeadingResult | AnnotationResult | ShortcutResult;

// ---------------------------------------------------------------------------
// Result derivations
// ---------------------------------------------------------------------------

// Commands: `>` prefix or no prefix
const commandResults = $derived.by((): ActionResult[] => {
  if (activePrefix !== null && activePrefix !== ">") return [];
  const actionsMap = getActionsMap();
  const q = searchText;
  const results: ActionResult[] = [];
  for (const action of actionsMap.values()) {
    if (
      !q ||
      action.label.toLowerCase().includes(q) ||
      action.group.toLowerCase().includes(q) ||
      (action.shortcut?.toLowerCase().includes(q) ?? false)
    ) {
      results.push({ kind: "action", id: action.id, action });
    }
  }
  return results;
});

// Headings: `#` prefix
const headingResults = $derived.by((): HeadingResult[] => {
  if (activePrefix !== "#") return [];
  const ed = editor;
  if (!ed || ed.isDestroyed) return [];
  const q = searchText;
  return walkHeadings(ed)
    .filter((h) => !q || h.text.toLowerCase().includes(q))
    .map((h, idx) => ({ kind: "heading" as const, id: `heading-${idx}`, ...h }));
});

// Annotations: `@` prefix — lazy, reactive on `annotations` prop change
const annotationResults = $derived.by((): AnnotationResult[] => {
  if (activePrefix !== "@") return [];
  const q = searchText;
  return annotations
    .filter((a) => {
      if (!q) return true;
      return a.content.toLowerCase().includes(q) || a.textSnapshot?.toLowerCase().includes(q);
    })
    .slice(0, 50)
    .map((a) => ({
      kind: "annotation" as const,
      id: `annotation-${a.id}`,
      label: a.content ? a.content.slice(0, 60) : "(no content)",
      snippet: a.textSnapshot ?? "",
      annotationType: a.type,
    }));
});

// Shortcuts: `?` prefix
const shortcutResults = $derived.by((): ShortcutResult[] => {
  if (activePrefix !== "?") return [];
  const q = searchText;
  const actionsMap = getActionsMap();
  const results: ShortcutResult[] = [];

  // Registry-derived shortcuts
  for (const action of actionsMap.values()) {
    if (!action.shortcut) continue;
    if (!q || action.label.toLowerCase().includes(q) || action.shortcut.toLowerCase().includes(q)) {
      results.push({
        kind: "shortcut",
        id: `shortcut-registry-${action.id}`,
        keys: action.shortcut,
        description: action.label,
        group: action.group,
      });
    }
  }

  // Static shortcuts
  for (let i = 0; i < STATIC_SHORTCUT_ROWS.length; i++) {
    const row = STATIC_SHORTCUT_ROWS[i];
    if (!q || row.description.toLowerCase().includes(q) || row.keys.toLowerCase().includes(q)) {
      results.push({
        kind: "shortcut",
        id: `shortcut-static-${i}`,
        keys: row.keys,
        description: row.description,
        group: "other",
      });
    }
  }

  return results;
});

// Flat list for keyboard navigation
const allResults = $derived<PaletteResult[]>([
  ...commandResults,
  ...headingResults,
  ...annotationResults,
  ...shortcutResults,
]);

$effect(() => {
  allResults;
  selectedIndex = 0;
});

$effect(() => {
  if (open) {
    query = "";
    selectedIndex = 0;
    Promise.resolve().then(() => inputEl?.focus());
  }
});

// Escape must close the palette regardless of which descendant holds focus and
// ahead of any nested handler that might consume the key. A capture-phase
// window listener (gated on `open`) is the robust pattern the other modals use;
// the modal-div `onkeydown` alone was unreliable. Registered once via onMount —
// the handler reads `open`/`onClose` through the closure, so there's no
// prop-read-in-cleanup retry-storm hazard.
onMount(() => {
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onEscape, { capture: true });
  return () => window.removeEventListener("keydown", onEscape, { capture: true });
});

// ---------------------------------------------------------------------------
// Input placeholder by mode
// ---------------------------------------------------------------------------

const PREFIX_PLACEHOLDER: Record<string, string> = {
  "#": "Search headings…",
  "@": "Search annotations…",
  "?": "Search shortcuts…",
  ">": "Search commands…",
};
const placeholder = $derived(
  activePrefix
    ? PREFIX_PLACEHOLDER[activePrefix]
    : "Type a command, # headings, @ annotations, ? shortcuts…",
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function close() {
  onClose();
}

function runResult(result: PaletteResult) {
  if (result.kind === "action") {
    close();
    void result.action.run();
  } else if (result.kind === "heading") {
    close();
    const ed = editor;
    if (!ed || ed.isDestroyed) return;
    const pos = result.pos;
    try {
      // pos may be stale if a concurrent edit removed or shifted the heading.
      const resolvedPos = ed.state.doc.resolve(pos + 1);
      const selection = TextSelection.near(resolvedPos);
      ed.view.dispatch(ed.state.tr.setSelection(selection).scrollIntoView());
      ed.view.focus();
    } catch {
      // Stale position — palette already closed, silently ignore.
    }
  } else if (result.kind === "annotation") {
    close();
    onFocusAnnotation?.(result.id.replace("annotation-", ""));
  }
  // shortcut items: display-only, no action on Enter
}

function handleKeydown(e: KeyboardEvent) {
  const total = allResults.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = (selectedIndex + 1) % Math.max(1, total);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = (selectedIndex - 1 + Math.max(1, total)) % Math.max(1, total);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const result = allResults[selectedIndex];
    if (result) runResult(result);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) close();
}
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- --tandem-z-above-titlebar covers the title bar's --tandem-z-titlebar lift
       (which clears tauri-plugin-decorum's overlay); without it the +new-tab
       button and Solo/Tandem toggle poke through the dimming backdrop. -->
  <div
    role="presentation"
    style="
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(2px);
      z-index: var(--tandem-z-above-titlebar);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 15vh;
    "
    onclick={handleBackdropClick}
    onkeydown={(e) => { if (e.key === "Escape") close(); }}
  >
    <div
      data-testid="command-palette"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Command palette"
      style="
        width: 640px; max-width: 92vw;
        background: var(--tandem-surface);
        border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-5);
        box-shadow: var(--tandem-shadow-4);
        overflow: hidden;
        display: flex; flex-direction: column;
      "
      onkeydown={handleKeydown}
    >
      <!-- Search input -->
      <div style="padding: var(--tandem-space-3) var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border);">
        <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
          <!-- Decorative leading search glyph; the input keeps the accessible name. -->
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--tandem-fg-faint)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            style="flex-shrink: 0;"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            bind:this={inputEl}
            data-testid="palette-input"
            type="text"
            {placeholder}
            aria-label="Search commands"
            aria-controls="palette-results"
            aria-activedescendant={allResults[selectedIndex] ? `palette-item-${allResults[selectedIndex].id}` : undefined}
            bind:value={query}
            style="
              flex: 1; min-width: 0; padding: 6px 0;
              font-size: var(--tandem-text-md); color: var(--tandem-fg);
              background: transparent; border: none; outline: none;
            "
          />
          <span class="palette-kbd" aria-hidden="true">Esc</span>
        </div>
        {#if activePrefix}
          <div style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
            {#if activePrefix === "#"}Searching document headings{/if}
            {#if activePrefix === "@"}Searching annotations{/if}
            {#if activePrefix === "?"}Showing keyboard shortcuts{/if}
            {#if activePrefix === ">"}Filtering commands{/if}
          </div>
        {/if}
      </div>

      <!-- Results -->
      <ul
        id="palette-results"
        role="listbox"
        aria-label="Results"
        class="tandem-scroll-fade-y"
        use:scrollFade={"y"}
        style="max-height: 400px; overflow-y: auto; padding: var(--tandem-space-1); list-style: none; margin: 0;"
      >
        {#if allResults.length === 0}
          <li
            data-testid="palette-empty"
            style="padding: var(--tandem-space-3) var(--tandem-space-4); font-size: var(--tandem-text-sm); color: var(--tandem-fg-faint); font-style: italic;"
          >
            {activePrefix === "#" ? "No headings found" : activePrefix === "@" ? "No annotations found" : activePrefix === "?" ? "No shortcuts found" : "No commands match"}
          </li>
        {:else}
          {#each allResults as result, i (result.id)}
            {@const isSelected = i === selectedIndex}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id={`palette-item-${result.id}`}
              data-testid={`palette-item-${result.id}`}
              role="option"
              aria-selected={isSelected}
              onclick={() => runResult(result)}
              onmouseenter={() => (selectedIndex = i)}
              style="
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px var(--tandem-space-3);
                border-radius: var(--tandem-r-3);
                transition: background 80ms;
                cursor: {result.kind === 'shortcut' ? 'default' : 'pointer'};
                background: {isSelected ? 'var(--tandem-accent-bg)' : 'transparent'};
                color: {isSelected ? 'var(--tandem-accent-fg-strong)' : 'var(--tandem-fg)'};
              "
            >
              {#if result.kind === "action"}
                <span style="font-size: var(--tandem-text-sm);">{result.action.label}</span>
                {#if result.action.shortcut}
                  <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-faint); font-family: var(--tandem-font-mono);">
                    {result.action.shortcut}
                  </span>
                {/if}
              {:else if result.kind === "heading"}
                <span style="display: flex; align-items: center; gap: var(--tandem-space-2);">
                  <span style="
                    font-size: var(--tandem-text-xs);
                    color: var(--tandem-fg-subtle);
                    font-family: var(--tandem-font-mono);
                    min-width: 20px;
                  ">H{result.level}</span>
                  <span style="font-size: var(--tandem-text-sm); padding-left: calc({result.level - 1} * var(--tandem-space-2));">{result.text}</span>
                </span>
              {:else if result.kind === "annotation"}
                <span style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0;">
                  <span style="font-size: var(--tandem-text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{result.label}</span>
                  {#if result.snippet}
                    <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">"{result.snippet}"</span>
                  {/if}
                </span>
                <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-faint); flex-shrink: 0; margin-left: var(--tandem-space-2);">
                  {result.annotationType.charAt(0).toUpperCase() + result.annotationType.slice(1)}
                </span>
              {:else if result.kind === "shortcut"}
                <span style="font-size: var(--tandem-text-sm);">{result.description}</span>
                <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-faint); font-family: var(--tandem-font-mono);">
                  {result.keys}
                </span>
              {/if}
            </li>
          {/each}
        {/if}
      </ul>

      <!-- Mode hints footer -->
      <div style="
        padding: var(--tandem-space-2) var(--tandem-space-4);
        border-top: 1px solid var(--tandem-border);
        background: var(--tandem-surface-muted);
        display: flex; align-items: center; gap: var(--tandem-space-3);
        font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);
      ">
        <span><kbd class="palette-kbd">#</kbd> headings</span>
        <span><kbd class="palette-kbd">@</kbd> annotations</span>
        <span><kbd class="palette-kbd">?</kbd> shortcuts</span>
        <span><kbd class="palette-kbd">&gt;</kbd> commands</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Keycap chip — bundle recipe (the thicker bottom border reads as a key
     edge). Shared by the input-row Esc hint and the footer prefix hints. */
  .palette-kbd {
    display: inline-block;
    padding: 1px 5px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-bottom-width: 2px;
    border-radius: var(--tandem-r-1);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-muted);
  }
</style>
