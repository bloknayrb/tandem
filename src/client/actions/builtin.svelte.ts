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

import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import { API_BASE } from "../utils/fileUpload.js";
import { type Action, registerAction } from "./registry.svelte.js";

// ---------------------------------------------------------------------------
// Dependency injection — App.svelte calls wireActionDeps on mount
// ---------------------------------------------------------------------------

interface ActionDeps {
  getActiveTabId: () => string | null;
  openSettings: () => void;
  toggleSoloMode: () => void;
  openFindBar: () => void; // wired when find/replace bar (PR 570) merges
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

export async function triggerSave(activeDocId: string | null): Promise<void> {
  if (!activeDocId || inflight) return;
  inflight = true;
  saving = true;
  try {
    const resp = await fetch(`http://localhost:${DEFAULT_MCP_PORT}/api/save`, {
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
    run() {
      guardedRun("toggle-mode", (d) => d.toggleSoloMode());
    },
  },
  {
    id: "new-scratchpad",
    label: "New Scratchpad",
    group: "document",
    async run() {
      try {
        await fetch(`${API_BASE}/scratchpad`, { method: "POST" });
      } catch (err) {
        console.warn("[Tandem] New Scratchpad request failed:", err);
      }
    },
  },
];

for (const action of BUILTINS) {
  registerAction(action);
}
