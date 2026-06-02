// Pure context detection for the native editor context menu — issue #923.
//
// Given the right-click target element + platform + selection state, decide
// which menu (if any) to show. Returning `null` means "do nothing, let the
// native WebView menu appear" — the macOS-plain-text passthrough that preserves
// Look Up / Services / spellcheck (locked decision). Kept free of DOM-editor
// and Tauri imports so it is unit-testable with plain element stubs.

import type { ContextMenuRequest } from "./types";

export type Platform = "macos" | "windows" | "linux";

export interface DetectInput {
  /** The `contextmenu` event target. */
  targetEl: { closest(selector: string): unknown };
  platform: Platform;
  /** Non-empty PM selection containing the click point. */
  hasSelection: boolean;
  /** Editor editability. */
  isEditable: boolean;
}

/**
 * Decide the context-menu request for a right-click, or `null` to fall through
 * to the native WebView menu.
 *
 * Precedence: link > table cell > plain text. A link inside a table cell shows
 * the link menu (the more specific noun under the cursor).
 *
 * macOS plain text returns `null` so the native dictionary/Services menu
 * survives; tables and links replace the menu on every platform because Look Up
 * has no value there. Windows/Linux plain text gets the custom menu (the bare
 * WebView menu is the issue's original pain point).
 */
export function detectContext(input: DetectInput): ContextMenuRequest | null {
  const { targetEl, platform, hasSelection, isEditable } = input;

  const overLink = targetEl.closest("a[href]") != null;
  const inTableCell = targetEl.closest("td, th") != null;

  // Table-capability flags are computed by the caller (needs `editor.can()`);
  // detection only fills the booleans it can know. The caller overwrites
  // canMergeCells/canSplitCell for the tableCell kind before invoking.
  const base = { hasSelection, isEditable, overLink, canMergeCells: false, canSplitCell: false };

  if (overLink) {
    return { kind: "link", ...base };
  }
  if (inTableCell) {
    return { kind: "tableCell", ...base };
  }
  // Plain editor text.
  if (platform === "macos") {
    return null; // preserve native Look Up / Services / spellcheck
  }
  return { kind: "editorText", ...base };
}

/** Map `navigator`/Tauri OS string to our {@link Platform} union. */
export function normalizePlatform(os: string): Platform {
  const lower = os.toLowerCase();
  if (lower.includes("mac") || lower === "darwin") return "macos";
  if (lower.includes("win")) return "windows";
  return "linux";
}
