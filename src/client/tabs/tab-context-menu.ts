// Pure helpers for the native tab-strip context menu — issue #923 (Phase 2).
//
// Mirrors the editor context-menu split: the request crossing the Tauri IPC
// boundary is booleans only, the action ids are a closed set, and the heavy
// wiring (listeners, invoke) lives in DocumentTabs.svelte. Kept import-light so
// it unit-tests without a DOM or Tauri.

import { isScratchpadPath, isUploadPath } from "../../shared/paths";

/**
 * Closed set of tab action ids Rust may emit back over `context-menu-action`.
 * Shared event with the editor menu; each surface validates against its own
 * set and drops the other's ids (harmless cross-delivery).
 */
export const TAB_CONTEXT_MENU_ACTION_IDS = [
  "ctx:tab:close",
  "ctx:tab:closeOthers",
  "ctx:tab:closeRight",
  "ctx:tab:copyPath",
  "ctx:tab:reveal",
] as const;

export type TabContextMenuActionId = (typeof TAB_CONTEXT_MENU_ACTION_IDS)[number];

const ACTION_ID_SET = new Set<string>(TAB_CONTEXT_MENU_ACTION_IDS);

export function isTabContextMenuActionId(id: unknown): id is TabContextMenuActionId {
  return typeof id === "string" && ACTION_ID_SET.has(id);
}

/** Boolean-only request sent to the `show_tab_context_menu` Tauri command. */
export interface TabContextMenuRequest {
  /** More than one tab is open → "Close Others" is meaningful. */
  canCloseOthers: boolean;
  /** At least one tab sits to the right of the clicked tab (display order). */
  canCloseRight: boolean;
  /** Tab maps to a real on-disk file (not scratchpad / upload) → Copy Path + Reveal. */
  hasPath: boolean;
}

/** Minimal tab shape the context computation needs. */
export interface TabRef {
  id: string;
  filePath: string;
}

/**
 * Compute the menu-item enablement for a right-clicked tab, using the tabs in
 * their current display order. `canCloseRight` is relative to that order; a
 * scratchpad or `upload://` tab has no real path so Copy Path / Reveal are off.
 */
export function buildTabMenuContext(tabs: readonly TabRef[], tabId: string): TabContextMenuRequest {
  const idx = tabs.findIndex((t) => t.id === tabId);
  const tab = idx >= 0 ? tabs[idx] : undefined;
  const hasPath = !!tab && !isScratchpadPath(tab.filePath) && !isUploadPath(tab.filePath);
  return {
    canCloseOthers: tabs.length > 1,
    canCloseRight: idx >= 0 && idx < tabs.length - 1,
    hasPath,
  };
}
