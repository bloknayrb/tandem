<script lang="ts">
import type { Editor } from "@tiptap/core";
import { TextSelection } from "prosemirror-state";

interface Props {
  editor: Editor | null;
}

type HeadingEntry = { text: string; level: number; pos: number };

let { editor }: Props = $props();

let headings = $state<HeadingEntry[]>([]);
let focusedIndex = $state<number>(-1);
let itemEls = $state<(HTMLButtonElement | null)[]>([]);

// Walk the doc and return heading entries. Mirrors doc.descendants pattern
// from authorship.ts:78.
function walkHeadings(ed: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && node.attrs.level <= 3) {
      result.push({ text: node.textContent, level: node.attrs.level as number, pos });
    }
  });
  return result;
}

$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) {
    headings = [];
    return;
  }

  // Seed immediately — don't wait for the first update event (CRDT may have
  // already synced before this component mounted).
  headings = walkHeadings(ed);
  itemEls = itemEls.slice(0, headings.length);
  if (focusedIndex >= headings.length) focusedIndex = Math.max(0, headings.length - 1);

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

function jumpTo(entry: HeadingEntry, index: number) {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  const { state } = ed;
  try {
    const resolved = state.doc.resolve(entry.pos + 1);
    const sel = TextSelection.near(resolved);
    ed.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    ed.view.focus();
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
  style="display: flex; flex-direction: column; flex: 1; overflow-y: auto; padding: var(--tandem-space-2) 0;"
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
        <li>
          <button
            bind:this={itemEls[i]}
            data-testid={`outline-heading-${entry.level}-${i}`}
            tabindex={focusedIndex === i || (focusedIndex === -1 && i === 0) ? 0 : -1}
            onclick={() => jumpTo(entry, i)}
            onfocus={() => (focusedIndex = i)}
            style={`
              display: block; width: 100%; text-align: left; padding: var(--tandem-space-1) var(--tandem-space-3);
              padding-left: calc(var(--tandem-space-1) + ${(entry.level - 1) * 12}px);
              font-size: ${entry.level === 1 ? "var(--tandem-text-sm)" : "var(--tandem-text-xs)"};
              font-weight: ${entry.level === 1 ? 600 : entry.level === 2 ? 500 : 400};
              color: ${entry.level === 1 ? "var(--tandem-fg)" : entry.level === 2 ? "var(--tandem-fg-subtle)" : "var(--tandem-fg-muted)"};
              background: none; border: none; cursor: pointer; line-height: 1.5;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              transition: color 0.1s, background 0.1s;
            `}
            title={entry.text}
            onmouseenter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--tandem-surface-hover, var(--tandem-surface-muted))";
            }}
            onmouseleave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            {entry.text || "(untitled)"}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
