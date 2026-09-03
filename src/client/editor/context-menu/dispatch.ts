// Action dispatch for the native editor context menu — issue #923.
//
// Maps a closed `ContextMenuActionId` (emitted by Rust) to a Tiptap/Yjs
// command. Native clipboard (Cut/Copy/Paste/Select All) never reaches here —
// those are OS `PredefinedMenuItem`s. Everything here must hit ProseMirror so it
// syncs through y-prosemirror identically to the keyboard path.
//
// The selection is already set to the click point (by `install.ts` via
// `posAtCoords`) before the menu opens, so position-sensitive commands act on
// the right place. `editor.chain().focus()` restores focus after the popup.

import type { Editor } from "@tiptap/core";
import { buildPlainTextSlice } from "../utils/plain-paste";
import { sanitizeHrefForPaste } from "../utils/url-safety";
import type { ContextMenuActionId } from "./types";

// Locally-typed chain for the commands we call, mirroring the slash-menu
// pattern (`slash-menu/commands.ts`). The table/undo/link command type
// augmentations live in their extension packages, which aren't imported by the
// pure-`.ts` tsc program — so we intersect them onto the chain here rather than
// pulling the extensions in at runtime. `.focus()` is applied in the helper.
type CtxChain = ReturnType<Editor["chain"]> & {
  addRowBefore: () => CtxChain;
  addRowAfter: () => CtxChain;
  addColumnBefore: () => CtxChain;
  addColumnAfter: () => CtxChain;
  deleteRow: () => CtxChain;
  deleteColumn: () => CtxChain;
  mergeCells: () => CtxChain;
  splitCell: () => CtxChain;
  deleteTable: () => CtxChain;
  extendMarkRange: (markName: string) => CtxChain;
  unsetLink: () => CtxChain;
};

function ctxChain(editor: Editor): CtxChain {
  return editor.chain().focus() as CtxChain;
}

export interface DispatchDeps {
  editor: Editor;
  /** Re-validates via `isSafeExternalHref` before navigating (security). */
  openHref: (href: string) => void;
  /** True only while the editor selection still matches the menu target. */
  isTargetCurrent: () => boolean;
  /** Read clipboard text on activation; null if unavailable/denied. */
  readClipboardText: () => Promise<string | null>;
  /** Write text to the clipboard (Copy Link). */
  writeClipboardText: (text: string) => Promise<void>;
  focusChat?: () => void;
  composeAnnotation?: (kind: "comment" | "note") => void;
  editLink?: () => void;
}

/**
 * A selection that is still live and still worth acting on. Deliberately does
 * NOT require `editor.isEditable`: its only callers are the three annotation /
 * Ask-AI arms, and annotating a read-only document is the point of opening one
 * (decision 2, #1798 — `.html` now opens read-only precisely so it can be read
 * and annotated rather than silently edited). `isEditable` stays on the arms
 * that actually mutate the document: `ctx:pastePlain`, `ctx:link:edit` and
 * `ctx:link:remove` each carry their own check.
 */
function hasLiveSelection(editor: Editor): boolean {
  return !editor.isDestroyed && !editor.state.selection.empty;
}

/** Resolve link state only when the native action fires. No href is retained. */
function resolveLiveLinkHref(editor: Editor, deps: DispatchDeps): string | null {
  if (editor.isDestroyed || !deps.isTargetCurrent() || !editor.isActive("link")) return null;
  const href = editor.getAttributes("link").href;
  return typeof href === "string" ? sanitizeHrefForPaste(href) : null;
}

/**
 * Run the editor command for an emitted action id. Unknown ids are dropped by
 * the caller (`isContextMenuActionId`) before reaching here, but the `default`
 * arm stays exhaustive-safe.
 */
export async function dispatchContextAction(
  id: ContextMenuActionId,
  deps: DispatchDeps,
): Promise<void> {
  const { editor } = deps;

  switch (id) {
    case "ctx:pastePlain": {
      if (editor.isDestroyed || !editor.isEditable) return;
      const text = await deps.readClipboardText();
      if (!text) return;
      // Reuse the exact plain-paste semantics of Ctrl+Shift+V (paragraph split
      // + active marks) rather than a raw insertText, so the two entry points
      // never diverge. View dispatch syncs through y-prosemirror.
      const { state, view } = editor;
      const slice = buildPlainTextSlice(text, state.schema, state.selection.$from.marks());
      view.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
      view.focus();
      return;
    }

    case "ctx:selection:askAi":
      if (hasLiveSelection(editor)) deps.focusChat?.();
      return;
    case "ctx:selection:comment":
      if (hasLiveSelection(editor)) deps.composeAnnotation?.("comment");
      return;
    case "ctx:selection:privateNote":
      if (hasLiveSelection(editor)) deps.composeAnnotation?.("note");
      return;

    case "ctx:table:insertRowAbove":
      ctxChain(editor).addRowBefore().run();
      return;
    case "ctx:table:insertRowBelow":
      ctxChain(editor).addRowAfter().run();
      return;
    case "ctx:table:insertColLeft":
      ctxChain(editor).addColumnBefore().run();
      return;
    case "ctx:table:insertColRight":
      ctxChain(editor).addColumnAfter().run();
      return;
    case "ctx:table:deleteRow":
      ctxChain(editor).deleteRow().run();
      return;
    case "ctx:table:deleteCol":
      ctxChain(editor).deleteColumn().run();
      return;
    case "ctx:table:mergeCells":
      ctxChain(editor).mergeCells().run();
      return;
    case "ctx:table:splitCell":
      ctxChain(editor).splitCell().run();
      return;
    case "ctx:table:deleteTable":
      ctxChain(editor).deleteTable().run();
      return;

    case "ctx:link:open": {
      const href = resolveLiveLinkHref(editor, deps);
      if (href) deps.openHref(href); // openHref re-runs isSafeExternalHref
      return;
    }
    case "ctx:link:copy": {
      const href = resolveLiveLinkHref(editor, deps);
      if (!href) return;
      await deps.writeClipboardText(href);
      return;
    }
    case "ctx:link:edit":
      if (editor.isEditable && resolveLiveLinkHref(editor, deps)) deps.editLink?.();
      return;
    case "ctx:link:remove": {
      if (!editor.isEditable || !resolveLiveLinkHref(editor, deps)) return;
      // Caret-inside-link: extend to the whole mark range before unsetting.
      ctxChain(editor).extendMarkRange("link").unsetLink().run();
      return;
    }

    default: {
      // Exhaustiveness guard — a new id added to the union without a case here
      // is a compile error.
      const _never: never = id;
      void _never;
      return;
    }
  }
}
