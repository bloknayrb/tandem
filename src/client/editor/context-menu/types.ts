// Shared types for the native (Tauri) editor context menu — issue #923.
//
// Security contract (enum-in / id-out): the `ContextMenuRequest` that crosses
// the Tauri IPC boundary carries only a kind enum + booleans — never an href or
// a path. Rust builds the menu from a FIXED id set and emits back one of the
// closed `ContextMenuActionId` strings; the sensitive link href stays
// module-local in `install.ts` and is re-validated on use. See the security
// review on #923.

/**
 * Which surface the right-click landed on. Drives the item set Rust builds.
 * `null` (from {@link detectContext}) means "let the native WebView menu
 * through" — used for macOS plain text so Look Up / Services / spellcheck
 * survive (the locked platform-conditional decision for #923).
 */
export type ContextMenuKind = "editorText" | "tableCell" | "link";

/** The request sent to the `show_context_menu` Tauri command. Booleans only. */
export interface ContextMenuRequest {
  kind: ContextMenuKind;
  /** Non-empty PM selection at popup time → enables Cut/Copy. */
  hasSelection: boolean;
  /** Editor is editable → enables mutating items. */
  isEditable: boolean;
  /** Right-clicked on/inside an `<a href>`. */
  overLink: boolean;
  /** `editor.can().mergeCells()` — gates the table Merge item. */
  canMergeCells: boolean;
  /** `editor.can().splitCell()` — gates the table Split item. */
  canSplitCell: boolean;
}

/**
 * Closed set of action ids that Rust may emit back to JS. Native clipboard
 * items (Cut/Copy/Paste/Select All) are `PredefinedMenuItem`s handled by the OS
 * and do NOT appear here — only items that must hit Tiptap/Yjs specifically.
 */
export const CONTEXT_MENU_ACTION_IDS = [
  "ctx:undo",
  "ctx:redo",
  "ctx:pastePlain",
  "ctx:table:insertRowAbove",
  "ctx:table:insertRowBelow",
  "ctx:table:insertColLeft",
  "ctx:table:insertColRight",
  "ctx:table:deleteRow",
  "ctx:table:deleteCol",
  "ctx:table:mergeCells",
  "ctx:table:splitCell",
  "ctx:table:deleteTable",
  "ctx:link:open",
  "ctx:link:copy",
  "ctx:link:remove",
] as const;

export type ContextMenuActionId = (typeof CONTEXT_MENU_ACTION_IDS)[number];

const ACTION_ID_SET = new Set<string>(CONTEXT_MENU_ACTION_IDS);

/** Validate an id arriving over the Tauri event bus against the closed set. */
export function isContextMenuActionId(id: unknown): id is ContextMenuActionId {
  return typeof id === "string" && ACTION_ID_SET.has(id);
}
