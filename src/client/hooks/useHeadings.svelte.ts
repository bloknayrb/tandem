import type { Editor as TiptapEditor } from "@tiptap/core";
import { type HeadingEntry, walkHeadings } from "../utils/headings.js";

export interface HeadingsState {
  readonly headings: HeadingEntry[];
}

export interface CreateHeadingsOpts {
  getEditor: () => TiptapEditor | null;
}

/**
 * Single source of truth for the document's heading outline (#832).
 *
 * Previously `OutlinePanel` computed this itself — `walkHeadings(editor)` in
 * an `$effect` plus its own `ed.on("update")` subscription. PeekStrip's left
 * peek needs the same data (real tick levels instead of five hardcoded
 * literals), and instantiating this hook a second time inside PeekStrip would
 * leave two live `update` subscriptions running `walkHeadings()` per
 * keystroke. Instantiate ONCE in App.svelte and thread the result down to
 * both OutlinePanel and PeekStrip as a prop.
 *
 * Deliberately subscribes to `update` only (never widens to `transaction`) —
 * see CLAUDE.md's note on `state_unsafe_mutation`: the `headings = ...`
 * write below happens synchronously inside the Tiptap event handler, and
 * `transaction` fires on every cursor move (no doc change), which would
 * multiply this write for no reason `update` doesn't already cover.
 */
export function createHeadings(opts: CreateHeadingsOpts): HeadingsState {
  let headings = $state<HeadingEntry[]>([]);

  $effect(() => {
    const ed = opts.getEditor();
    if (!ed || ed.isDestroyed) {
      headings = [];
      return;
    }

    headings = walkHeadings(ed);

    const handler = () => {
      headings = walkHeadings(ed);
    };
    ed.on("update", handler);

    return () => {
      if (!ed.isDestroyed) ed.off("update", handler);
      headings = [];
    };
  });

  return {
    get headings() {
      return headings;
    },
  };
}
