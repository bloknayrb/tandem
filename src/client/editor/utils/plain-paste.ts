// Plain-text paste slice builder, shared between two surfaces that must agree
// on what "paste as plain text" means:
//   1. The editor's `clipboardTextParser` plain branch (Ctrl+Shift+V), and
//   2. The native context menu's "Paste as Plain Text" item (issue #923).
//
// Both split on blank-line groups into paragraphs and carry the insertion
// context's active marks, mirroring the `else` branch of prosemirror-view's
// `parseFromClipboard`. Factoring this guarantees the two entry points produce
// identical documents for the same clipboard text (a divergence the CRDT
// review flagged for issue #923).

import { Fragment, type Mark, type Schema, Slice } from "@tiptap/pm/model";

/**
 * Build a {@link Slice} of paragraphs from raw clipboard text, with no markdown
 * interpretation. `marks` are the active marks at the insertion point (so a
 * paste inside bold text stays bold); pass `$context.marks()` from the
 * clipboard parser or `state.selection.$from.marks()` from a command.
 */
export function buildPlainTextSlice(text: string, schema: Schema, marks: readonly Mark[]): Slice {
  const nodes = text
    .split(/(?:\r\n?|\n)+/)
    .map((block) =>
      schema.nodes.paragraph.create(null, block ? schema.text(block, marks) : undefined),
    );
  return Slice.maxOpen(Fragment.fromArray(nodes));
}
