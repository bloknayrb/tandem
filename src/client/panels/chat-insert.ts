import type { Editor } from "@tiptap/core";
import { markdownToSlice } from "../editor/utils/markdown-paste";

/** Insert one chat body through the sanitized paste parser in one history transaction. */
export function insertChatMarkdown(editor: Editor, markdown: string): void {
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
  transaction.setMeta("addToHistory", true).scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.focus();
}
