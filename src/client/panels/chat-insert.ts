import type { Editor } from "@tiptap/core";
import type { AuthorshipRange } from "../../shared/types";
import { AUTHORSHIP_ORIGIN_META } from "../editor/extensions/authorship";
import { markdownToSlice } from "../editor/utils/markdown-paste";

/**
 * Insert one chat body through the sanitized paste parser in one history
 * transaction, attributed to whoever wrote the message.
 *
 * `author` is threaded from the message rather than hardcoded to `"claude"`:
 * the Insert affordance in `ChatPanel.svelte` is rendered for every message,
 * the user's own included, so a hardcoded value would fix #1388's inversion by
 * introducing its mirror image.
 */
export function insertChatMarkdown(
  editor: Editor,
  markdown: string,
  author: AuthorshipRange["author"],
): void {
  const slice = markdownToSlice(markdown, editor.schema);
  let transaction = editor.state.tr;
  if (slice) {
    transaction = transaction.replaceSelection(slice);
  } else {
    // Plain text bypasses Tiptap's HTML-string content path.
    transaction = transaction.insertText(
      markdown,
      editor.state.selection.from,
      editor.state.selection.to,
    );
  }
  // Both branches reassign `transaction` above, so one setMeta covers each.
  transaction
    .setMeta("addToHistory", true)
    .setMeta(AUTHORSHIP_ORIGIN_META, author)
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.focus();
}
