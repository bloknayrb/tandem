/**
 * Built-in action registrations for the command palette.
 *
 * Action shapes are registered at module import time so the Shortcuts settings
 * tab has a non-empty list on first paint. The `run()` functions reference
 * lazily-resolved dependency getters; if a getter hasn't been wired yet (App
 * hasn't mounted) the action logs a warning and no-ops rather than crashing.
 *
 * Wire the getters by calling wireActionDeps() from App.svelte after mount.
 */

import { API_SAVE, API_SCRATCHPAD } from "../../shared/api-paths.js";
import { API_BASE } from "../utils/fileUpload.js";
import { type Action, registerAction } from "./registry.svelte.js";

// ---------------------------------------------------------------------------
// Dependency injection — App.svelte calls wireActionDeps on mount
// ---------------------------------------------------------------------------

interface ActionDeps {
  getActiveTabId: () => string | null;
  openSettings: () => void;
  toggleSoloMode: () => void;
  openFindBar: () => void;
  openFindBarTabs: () => void;
  findNext: () => void;
  findPrev: () => void;
  closeActiveTab: () => void;
  openFileDialog: () => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  reopenClosedTab: () => void;
  annotationNext: () => void;
  annotationPrev: () => void;
  annotationAccept: () => void;
  annotationDismiss: () => void;
  selectBlock: () => void;
  toggleAuthorship: () => void;
}

let deps: ActionDeps | null = null;

export function wireActionDeps(d: ActionDeps): void {
  deps = d;
}

function guardedRun(id: string, fn: (d: ActionDeps) => void | Promise<void>) {
  if (!deps) {
    console.warn(`[actions] "${id}" invoked before App mounted — deps not wired yet`);
    return;
  }
  fn(deps);
}

// ---------------------------------------------------------------------------
// Save — mirrors useSaveShortcut.svelte.ts logic
// ---------------------------------------------------------------------------

let saving = $state(false);
export const saveStore = {
  get saving() {
    return saving;
  },
};
let inflight = false;

let scratchpadInflight = false;

export async function createScratchpad(): Promise<void> {
  if (scratchpadInflight) return;
  scratchpadInflight = true;
  try {
    const res = await fetch(`${API_BASE}${API_SCRATCHPAD}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn(
        "[Tandem] New Scratchpad failed:",
        (body as Record<string, string>).message ?? res.statusText,
      );
    }
  } catch (err) {
    console.warn("[Tandem] New Scratchpad request failed:", err);
  } finally {
    scratchpadInflight = false;
  }
}

export async function triggerSave(activeDocId: string | null): Promise<void> {
  if (!activeDocId || inflight) return;
  inflight = true;
  saving = true;
  try {
    const resp = await fetch(`${API_BASE}${API_SAVE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: activeDocId }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.warn(
        "[Tandem] Save failed:",
        (body as Record<string, string>).message ?? resp.statusText,
      );
    }
  } catch (err) {
    console.warn("[Tandem] Save request failed:", err);
  } finally {
    inflight = false;
    saving = false;
  }
}

// ---------------------------------------------------------------------------
// Register all builtins at module top-level
// ---------------------------------------------------------------------------

const BUILTINS: Action[] = [
  {
    id: "save",
    label: "Save document",
    group: "document",
    shortcut: "Ctrl+S",
    run() {
      guardedRun("save", (d) => void triggerSave(d.getActiveTabId()));
    },
  },
  {
    id: "settings",
    label: "Open settings",
    group: "view",
    shortcut: "Ctrl+,",
    run() {
      guardedRun("settings", (d) => d.openSettings());
    },
  },
  {
    id: "toggle-mode",
    label: "Toggle Solo / Tandem mode",
    group: "document",
    shortcut: "Ctrl+Shift+M",
    run() {
      guardedRun("toggle-mode", (d) => d.toggleSoloMode());
    },
  },
  {
    id: "new-scratchpad",
    label: "New Scratchpad",
    group: "document",
    shortcut: "Ctrl+N",
    run() {
      void createScratchpad();
    },
  },
  {
    id: "close-tab",
    label: "Close active tab",
    group: "document",
    shortcut: "Ctrl+W",
    run() {
      guardedRun("close-tab", (d) => d.closeActiveTab());
    },
  },
  {
    id: "open-file",
    label: "Open file…",
    group: "document",
    shortcut: "Ctrl+O",
    run() {
      guardedRun("open-file", (d) => d.openFileDialog());
    },
  },
  {
    id: "find",
    label: "Find / Replace",
    group: "navigation",
    shortcut: "Ctrl+F",
    run() {
      guardedRun("find", (d) => d.openFindBar());
    },
  },
  {
    id: "find-in-tabs",
    label: "Find in open tabs",
    group: "navigation",
    shortcut: "Ctrl+Shift+F",
    run() {
      guardedRun("find-in-tabs", (d) => d.openFindBarTabs());
    },
  },
  {
    id: "find-next",
    label: "Find next match",
    group: "navigation",
    shortcut: "Ctrl+G",
    run() {
      guardedRun("find-next", (d) => d.findNext());
    },
  },
  {
    id: "find-previous",
    label: "Find previous match",
    group: "navigation",
    shortcut: "Ctrl+Shift+G",
    run() {
      guardedRun("find-previous", (d) => d.findPrev());
    },
  },
  {
    id: "toggle-left-panel",
    label: "Toggle left panel",
    group: "view",
    shortcut: "Ctrl+\\",
    run() {
      guardedRun("toggle-left-panel", (d) => d.toggleLeftPanel());
    },
  },
  {
    id: "toggle-right-panel",
    label: "Toggle right panel",
    group: "view",
    shortcut: "Ctrl+Shift+\\",
    run() {
      guardedRun("toggle-right-panel", (d) => d.toggleRightPanel());
    },
  },
  {
    id: "reopen-closed-tab",
    label: "Reopen closed tab (this session)",
    group: "document",
    shortcut: "Ctrl+Alt+T",
    run() {
      guardedRun("reopen-closed-tab", (d) => d.reopenClosedTab());
    },
  },
  {
    id: "annotation-next",
    label: "Next annotation",
    group: "annotations",
    shortcut: "Alt+]",
    run() {
      guardedRun("annotation-next", (d) => d.annotationNext());
    },
  },
  {
    id: "annotation-previous",
    label: "Previous annotation",
    group: "annotations",
    shortcut: "Alt+[",
    run() {
      guardedRun("annotation-previous", (d) => d.annotationPrev());
    },
  },
  {
    id: "annotation-accept",
    label: "Accept focused annotation",
    group: "annotations",
    shortcut: "Ctrl+Enter",
    run() {
      guardedRun("annotation-accept", (d) => d.annotationAccept());
    },
  },
  {
    id: "annotation-dismiss",
    label: "Dismiss focused annotation",
    group: "annotations",
    shortcut: "Ctrl+Shift+Enter",
    run() {
      guardedRun("annotation-dismiss", (d) => d.annotationDismiss());
    },
  },
  // Note: comment-on-selection (Ctrl+Alt+M) is intentionally NOT registered as
  // a palette action — opening the palette collapses the editor selection
  // (focus moves to palette input), so a palette-invoked "comment on selection"
  // would always fire with no selection. Static row in static-shortcuts.ts.
  {
    id: "select-block",
    label: "Select containing block",
    group: "editor",
    shortcut: "Alt+L",
    run() {
      guardedRun("select-block", (d) => d.selectBlock());
    },
  },
  {
    id: "toggle-authorship",
    label: "Toggle authorship colors",
    group: "view",
    shortcut: "Ctrl+Alt+A",
    run() {
      guardedRun("toggle-authorship", (d) => d.toggleAuthorship());
    },
  },
];

for (const action of BUILTINS) {
  registerAction(action);
}
