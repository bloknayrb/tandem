<script lang="ts">
import type { Editor } from "@tiptap/core";
import { TextSelection } from "prosemirror-state";
import { untrack } from "svelte";
import type { Annotation } from "../../shared/types";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import type { FilterAuthor, FilterStatus, FilterType } from "../panels/FilterBar.svelte";
import { flatOffsetToPmPos } from "../positions";
import { type HeadingEntry, walkHeadings } from "../utils/headings";

interface Props {
  editor: Editor | null;
  annotations?: Annotation[];
  focusTrigger?: number;
  activeFilterType?: FilterType;
  activeFilterAuthor?: FilterAuthor;
  activeFilterStatus?: FilterStatus;
}

let {
  editor,
  annotations = [],
  focusTrigger = 0,
  activeFilterType = "all",
  activeFilterAuthor = "all",
  activeFilterStatus = "all",
}: Props = $props();

let headings = $state<HeadingEntry[]>([]);
let focusedIndex = $state<number>(-1);
let itemEls = $state<(HTMLButtonElement | null)[]>([]);
let searchQuery = $state("");
let searchInput = $state<HTMLInputElement | null>(null);
let scrollSpyIndex = $state<number>(-1);

$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) {
    headings = [];
    return;
  }

  headings = walkHeadings(ed);
  // Use untrack to avoid a self-referential read→write cycle on itemEls.
  // .slice() always returns a new array reference; tracking it would cause
  // effect_update_depth_exceeded. focusedIndex has the same issue.
  untrack(() => {
    itemEls = itemEls.slice(0, headings.length);
    if (focusedIndex >= headings.length) focusedIndex = Math.max(0, headings.length - 1);
  });

  const handler = () => {
    headings = walkHeadings(ed);
    itemEls = itemEls.slice(0, headings.length);
    if (focusedIndex >= headings.length) focusedIndex = Math.max(0, headings.length - 1);
  };
  ed.on("update", handler);

  return () => {
    if (!ed.isDestroyed) ed.off("update", handler);
    headings = [];
  };
});

// Focus search input when focusTrigger changes (triggered by Ctrl+F from App.svelte).
$effect(() => {
  if (focusTrigger > 0) {
    searchInput?.focus();
    searchInput?.select();
  }
});

// Scroll-spy: track which heading is currently visible.
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;

  function updateScrollSpy() {
    if (!ed || ed.isDestroyed || headings.length === 0) {
      scrollSpyIndex = -1;
      return;
    }
    const editorRect = ed.view.dom.getBoundingClientRect();
    const threshold = editorRect.top + 48;
    let activeIdx = -1;
    for (let i = 0; i < headings.length; i++) {
      try {
        const coords = ed.view.coordsAtPos(headings[i].pos + 1);
        if (coords.top <= threshold) activeIdx = i;
      } catch {
        // pos may be stale after a concurrent edit
      }
    }
    scrollSpyIndex = activeIdx;
  }

  updateScrollSpy();

  const scrollEl = ed.view.dom.closest(".editor-scroll") ?? ed.view.dom.parentElement;
  scrollEl?.addEventListener("scroll", updateScrollSpy);
  return () => scrollEl?.removeEventListener("scroll", updateScrollSpy);
});

// Drive find-replace from search input.
function handleSearchInput() {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  if (searchQuery) {
    ed.commands.find({
      query: searchQuery,
      caseSensitive: false,
      wholeWord: false,
      regexMode: false,
    });
  } else {
    ed.commands.findClose();
  }
}

function handleSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      editor?.commands.findPrev();
    } else {
      editor?.commands.findNext();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    searchQuery = "";
    editor?.commands.findClose();
    searchInput?.blur();
  }
}

const headingAnnotationCounts = $derived.by(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed || headings.length === 0) return [] as number[];
  const docEnd = ed.state.doc.content.size;

  // Single pass: resolve all annotation PM positions, then bucket per heading.
  const annPositions: number[] = [];
  for (const ann of annotations) {
    // Mirror all three active filters so counts match the side panel.
    if (activeFilterType !== "all") {
      if (activeFilterType === "with-replacement") {
        if (!ann.suggestedText) continue;
      } else if (ann.type !== activeFilterType) continue;
    }
    if (activeFilterAuthor !== "all" && ann.author !== activeFilterAuthor) continue;
    if (activeFilterStatus !== "all" && ann.status !== activeFilterStatus) continue;
    try {
      annPositions.push(flatOffsetToPmPos(ed.state.doc, ann.range.from));
    } catch {
      // skip annotations with invalid ranges
    }
  }

  return headings.map((h, i) => {
    const sectionEnd = i + 1 < headings.length ? headings[i + 1].pos : docEnd;
    return annPositions.filter((p) => p >= h.pos && p < sectionEnd).length;
  });
});

function jumpTo(entry: HeadingEntry, index: number) {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  const { state } = ed;
  try {
    const resolved = state.doc.resolve(entry.pos + 1);
    const sel = TextSelection.near(resolved);
    ed.view.dispatch(state.tr.setSelection(sel));
    ed.view.focus();
    // Scroll the heading to the top of the editor's scroll container.
    const { node } = ed.view.domAtPos(entry.pos + 1);
    const el = (node instanceof Element ? node : node.parentElement) as HTMLElement | null;
    const scroller = (ed.view.dom.closest(".editor-scroll") ??
      ed.view.dom.parentElement) as HTMLElement | null;
    if (el && scroller) {
      const elTop = el.getBoundingClientRect().top;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += elTop - scrollerTop - scroller.clientHeight * 0.05;
    }
  } catch {
    // pos may have been invalidated by a concurrent edit — ignore
  }
  focusedIndex = index;
}

function handleKeyDown(e: KeyboardEvent) {
  if (headings.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = (focusedIndex + 1) % headings.length;
    focusedIndex = next;
    itemEls[next]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const prev = (focusedIndex - 1 + headings.length) % headings.length;
    focusedIndex = prev;
    itemEls[prev]?.focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    focusedIndex = 0;
    itemEls[0]?.focus();
  } else if (e.key === "End") {
    e.preventDefault();
    focusedIndex = headings.length - 1;
    itemEls[headings.length - 1]?.focus();
  }
}
</script>

<!--
  APG roving tabindex pattern: keydown on the composite widget's outer container
  so arrow keys navigate between heading buttons. The `<nav>` landmark is the
  correct container (not a `<div>`) but Svelte's rule fires anyway.
-->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<nav
  data-testid="outline-panel"
  aria-label="Document outline"
  onkeydown={handleKeyDown}
  style="display: flex; flex-direction: column; flex: 1; overflow-y: auto;"
>
  <!-- Search field -->
  <div style="padding: var(--tandem-space-2) var(--tandem-space-3); border-bottom: 1px solid var(--tandem-border);">
    <input
      bind:this={searchInput}
      bind:value={searchQuery}
      oninput={handleSearchInput}
      onkeydown={handleSearchKeydown}
      type="search"
      placeholder="Search in document…"
      data-testid="outline-search-input"
      aria-label="Search document"
      style="
        width: 100%; box-sizing: border-box;
        padding: var(--tandem-space-1) var(--tandem-space-3);
        font-size: var(--tandem-text-xs);
        border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-pill);
        background: var(--tandem-surface);
        color: var(--tandem-fg);
        outline: none;
      "
    />
  </div>

  <!-- Headings list -->
  <div
    class="tandem-scroll-fade-y"
    use:scrollFade={"y"}
    style="flex: 1; overflow-y: auto; padding: var(--tandem-space-2) 0;"
  >
    {#if headings.length === 0}
      <div
        style="padding: var(--tandem-space-3) var(--tandem-space-4); font-size: var(--tandem-text-xs); color: var(--tandem-fg-faint); font-style: italic;"
      >
        No headings
      </div>
    {:else}
      <!-- ul + li + button: correct semantics for a roving-tabindex list of actions -->
      <ul style="list-style: none; margin: 0; padding: 0;">
        {#each headings as entry, i (i)}
          {@const isActive = scrollSpyIndex === i}
          {@const count = headingAnnotationCounts[i] ?? 0}
          <li>
            <button
              bind:this={itemEls[i]}
              data-testid={`outline-heading-${entry.level}-${i}`}
              tabindex={focusedIndex === i || (focusedIndex === -1 && i === 0) ? 0 : -1}
              onclick={() => jumpTo(entry, i)}
              onfocus={() => (focusedIndex = i)}
              style={`
                display: flex; align-items: center; width: 100%; text-align: left;
                padding: var(--tandem-space-1) var(--tandem-space-3);
                padding-left: calc(var(--tandem-space-1) + ${(entry.level - 1) * 12}px);
                font-size: ${entry.level === 1 ? "var(--tandem-text-sm)" : "var(--tandem-text-xs)"};
                font-weight: ${entry.level === 1 ? 600 : entry.level === 2 ? 500 : 400};
                color: ${isActive ? "var(--tandem-accent)" : entry.level === 1 ? "var(--tandem-fg)" : entry.level === 2 ? "var(--tandem-fg-subtle)" : "var(--tandem-fg-muted)"};
                background: ${isActive ? "var(--tandem-accent-bg)" : "none"};
                border: none; cursor: pointer; line-height: 1.5;
                transition: color 0.1s, background 0.1s;
                gap: var(--tandem-space-2);
              `}
              title={entry.text}
              onmouseenter={(e) => {
                if (!isActive)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "var(--tandem-surface-hover, var(--tandem-surface-muted))";
              }}
              onmouseleave={(e) => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "none";
              }}
            >
              <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                {entry.text || "(untitled)"}
              </span>
              {#if count > 0}
                <span
                  style="
                    flex-shrink: 0;
                    font-size: var(--tandem-text-2xs, 10px);
                    font-weight: 500;
                    color: var(--tandem-fg-subtle);
                    background: var(--tandem-surface-muted);
                    border-radius: var(--tandem-r-pill);
                    padding: 0 var(--tandem-space-1);
                    min-width: 16px;
                    text-align: center;
                    line-height: 16px;
                  "
                  title="{count} annotation{count !== 1 ? 's' : ''}"
                >
                  {count}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</nav>
