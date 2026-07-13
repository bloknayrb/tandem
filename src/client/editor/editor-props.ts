// Tiptap `editorProps` factory for the Tandem editor (A5). Extracted from
// Editor.svelte so it's a plain, testable module: tests can exercise the
// exact production paste/link handlers instead of a hand-copied
// re-implementation (see tests/client/link-paste.test.ts and
// tests/client/editor-smart-typography.test.ts).

import { TextSelection } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";
import { markdownToSlice } from "./utils/markdown-paste";
import { buildPlainTextSlice } from "./utils/plain-paste";
import { isSafeExternalHref } from "./utils/url-safety";

// Full `editorProps` factory (A5). Tiptap's `editor.setOptions({ editorProps
// })` replaces `editorProps` wholesale — it is NOT a shallow merge — so
// toggling spellcheck without recreating the editor requires re-supplying
// every existing prop (attributes, clipboardTextParser, handlePaste) plus
// the new `spellcheck` attribute, not just the changed piece.
export function makeEditorProps(spellcheckOnValue: boolean): EditorProps {
  return {
    attributes: {
      class: "tandem-editor",
      // `min-height` lives in editor.css (`.tandem-editor` = 500px,
      // `.tandem-paged .tandem-editor` = 1056px). Inline `min-height` here
      // would beat the paged-layout selector via specificity and silently
      // lose the 11in sheet height for .docx.
      style: "outline: none; font-size: var(--tandem-editor-font-size, 16px); line-height: 1.6;",
      // Emitted explicitly in both directions (not omitted when on) so the
      // attribute is symmetric and testable.
      spellcheck: String(spellcheckOnValue),
    },
    // Paste raw markdown as formatted rich text (#788). We return a parsed
    // ProseMirror Slice so y-prosemirror's sync plugin captures it via the
    // normal paste transaction — we never touch the Y.Doc directly. When the
    // user requests plain-text paste (Ctrl+Shift+V → `plain === true`), or the
    // text isn't markdown-ish, we fall through to plain-text parsing.
    clipboardTextParser: (text, $context, plain, view) => {
      if (!plain) {
        const slice = markdownToSlice(text, view.state.schema);
        if (slice) return slice;
      }
      // Fall back to plain-text behavior: split on blank-line groups into
      // paragraphs, carrying the context's active marks. Shared with the
      // context menu's "Paste as Plain Text" (issue #923) so the two never
      // diverge.
      return buildPlainTextSlice(text, view.state.schema, $context.marks());
    },
    // Paste URL over a non-empty selection → link the selected text instead
    // of replacing it. Direct `editorProps` handlers run BEFORE both
    // `clipboardTextParser` above and Link's own `pasteHandler` plugin, so
    // returning true here suppresses both — no double handling regardless
    // of whether Link's paste-link behavior would also have fired.
    // Ctrl+Shift+V (plain paste) hits this path too: a bare URL carries no
    // formatting to strip, so "plain paste" and "rich paste" produce the
    // same result here. We deliberately don't branch on ProseMirror's
    // internal `view.input.shiftKey` — not a stable API surface.
    handlePaste: (view, event) => {
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (!text || /\s/.test(text)) return false;
      if (!isSafeExternalHref(text)) return false;

      const { selection } = view.state;
      if (selection.empty || !(selection instanceof TextSelection)) return false;

      const linkType = view.state.schema.marks.link;
      if (!linkType) return false;

      // Build the transaction first and only claim the event if it actually
      // did something. `addMark` only produces steps for text nodes whose
      // parent `allowsMarkType(link)` — e.g. a selection inside a code block
      // yields zero steps, since the codeBlock schema forbids the link mark
      // entirely. We check `tr.steps.length` rather than pre-checking
      // `selection.$from.parent` because that also correctly handles mixed
      // multi-block selections: if ANY part of the range can carry the link
      // mark, `addMark` still applies it there (partial application is
      // normal ProseMirror behavior), and we should still dispatch and claim
      // the event in that case.
      //
      // When we return false, control passes on: Link's own `pasteHandler`
      // plugin runs next and (verified empirically) ALSO falls through
      // inside a code block — its `setMark` call hits the same
      // `canSetMark` === false wall — so it doesn't intercept either. Only
      // then does `clipboardTextParser` get a shot at the pasted slice,
      // which inserts the URL as plain text into the code block. That's the
      // same fallthrough chain the `javascript:`-scheme rejection above
      // already relies on.
      //
      // Corollary: re-pasting a URL that's already the link's href over the
      // same range also produces zero steps (the mark is already applied,
      // so `addMark` is a no-op) — we return false, and Link's plugin claims
      // the event and no-ops too, which is byte-identical to today's
      // behavior for that case.
      const tr = view.state.tr.addMark(
        selection.from,
        selection.to,
        linkType.create({ href: text }),
      );
      if (tr.steps.length === 0) return false;
      view.dispatch(tr);
      return true;
    },
  };
}
