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
  "ctx:tab:closeLeft",
  "ctx:tab:closeOthers",
  "ctx:tab:closeRight",
  "ctx:tab:rename",
  "ctx:tab:save",
  "ctx:tab:copyFileName",
  "ctx:tab:copyPath",
  "ctx:tab:reveal",
  "ctx:tab:toggleSourceView",
] as const;

export type TabContextMenuActionId = (typeof TAB_CONTEXT_MENU_ACTION_IDS)[number];

const ACTION_ID_SET = new Set<string>(TAB_CONTEXT_MENU_ACTION_IDS);

export function isTabContextMenuActionId(id: unknown): id is TabContextMenuActionId {
  return typeof id === "string" && ACTION_ID_SET.has(id);
}

/** Boolean-only request sent to the `show_tab_context_menu` Tauri command. */
export interface TabContextMenuRequest {
  /** At least one tab sits to the left of the clicked tab. */
  canCloseLeft: boolean;
  /** More than one tab is open → "Close Others" is meaningful. */
  canCloseOthers: boolean;
  /** At least one tab sits to the right of the clicked tab (display order). */
  canCloseRight: boolean;
  /** The clicked tab is a writable on-disk document. */
  canRename: boolean;
  /** The clicked tab is writable and can be saved/promoted. */
  canSave: boolean;
  /** True selects the fixed Save As label for the save leaf. */
  saveAs: boolean;
  /** A live tab always has a display filename; false only for stale ids. */
  canCopyFileName: boolean;
  /** Tab maps to a real on-disk file (not scratchpad / upload) → Copy Path + Reveal. */
  hasPath: boolean;
  /** Writable Markdown documents may enter/exit source view. */
  canToggleSourceView: boolean;
  /** True selects the fixed Return to Formatted Editor label. */
  sourceViewActive: boolean;
}

/** Minimal tab shape the context computation needs. */
export interface TabRef {
  id: string;
  filePath: string;
  fileName?: string;
  format?: string;
  readOnly?: boolean;
  source?: "file" | "upload";
}

/**
 * True when a tab maps to a real on-disk file (not a scratchpad / `upload://`
 * synthetic path). Gates Copy Path + Reveal. Shared by the menu-enablement
 * computation and the action dispatcher so the webview re-validates rather than
 * trusting the menu's enabled state alone (mirrors the editor's `ctx:link:open`
 * href re-check; defense-in-depth against a forged action event).
 */
export function hasRealPath(filePath: string): boolean {
  return !isScratchpadPath(filePath) && !isUploadPath(filePath);
}

/**
 * Compute the menu-item enablement for a right-clicked tab, using the tabs in
 * their current display order. `canCloseRight` is relative to that order; a
 * scratchpad or `upload://` tab has no real path so Copy Path / Reveal are off.
 */
export function buildTabMenuContext(
  tabs: readonly TabRef[],
  tabId: string,
  sourceViewActive = false,
): TabContextMenuRequest {
  const idx = tabs.findIndex((t) => t.id === tabId);
  const tab = idx >= 0 ? tabs[idx] : undefined;
  const uploadBacked = !!tab && (tab.source === "upload" || isUploadPath(tab.filePath));
  const writable = !!tab && tab.readOnly !== true;
  return {
    canCloseLeft: idx > 0,
    canCloseOthers: tabs.length > 1,
    canCloseRight: idx >= 0 && idx < tabs.length - 1,
    canRename: writable && !uploadBacked,
    canSave: writable,
    saveAs: uploadBacked,
    canCopyFileName: !!tab,
    hasPath: !!tab && hasRealPath(tab.filePath),
    canToggleSourceView: writable && tab?.format === "md",
    sourceViewActive: !!tab && sourceViewActive,
  };
}

/** Ids before `fromId`, in display order. Stale ids deliberately close nothing. */
export function tabIdsToCloseLeft(tabs: readonly TabRef[], fromId: string): string[] {
  const idx = tabs.findIndex((t) => t.id === fromId);
  if (idx <= 0) return [];
  return tabs.slice(0, idx).map((t) => t.id);
}

/**
 * Ids of the tabs to close for "Close Others", relative to `keepId`. Returns an
 * empty list when `keepId` is not present in `tabs` — guards against the
 * stale-id footgun where a vanished keep-target would otherwise close *every*
 * tab. The caller closes the returned ids (and never `keepId`).
 */
export function tabIdsToCloseOthers(tabs: readonly TabRef[], keepId: string): string[] {
  if (!tabs.some((t) => t.id === keepId)) return [];
  return tabs.filter((t) => t.id !== keepId).map((t) => t.id);
}

/**
 * Ids of the tabs to close for "Close to the Right", in display order. Empty
 * when `fromId` is missing or is already the last tab.
 */
export function tabIdsToCloseRight(tabs: readonly TabRef[], fromId: string): string[] {
  const idx = tabs.findIndex((t) => t.id === fromId);
  if (idx < 0) return [];
  return tabs.slice(idx + 1).map((t) => t.id);
}
