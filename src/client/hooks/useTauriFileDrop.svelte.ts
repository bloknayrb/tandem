/**
 * Tauri-only native drag-drop bridge.
 *
 * With `dragDropEnabled: true` in `tauri.conf.json`, the webview suppresses
 * HTML5 DnD events and emits Tauri's `onDragDropEvent` with real filesystem
 * paths instead. This hook subscribes once at app startup and routes
 * dropped files to `openServerPath()` so they open as editable documents
 * (the same flow used by `tandem` CLI and OS file association), rather
 * than the read-only `upload://` session that browser-mode `useFileDrop`
 * produces.
 *
 * Mirrors `useTauriTheme.svelte.ts` in shape: module-level singleton state,
 * idempotent init, `_resetForTests()` for unit-test isolation.
 */
import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { openServerPath } from "../utils/server-paths.js";

let fileDragOver = $state(false);
let _initialized = false;
let _unlisten: (() => void) | null = null;

export const tauriFileDrop = {
  get fileDragOver() {
    return fileDragOver;
  },
};

function extensionAllowed(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export function initTauriFileDrop(): void {
  if (_initialized) return;
  if (!isTauriRuntime()) return;
  _initialized = true;

  import("@tauri-apps/api/webview")
    .then(async ({ getCurrentWebview }) => {
      _unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as
          | { type: "enter"; paths: string[] }
          | { type: "over" }
          | { type: "drop"; paths: string[] }
          | { type: "leave" };
        switch (payload.type) {
          case "enter":
            fileDragOver = true;
            return;
          case "drop":
            fileDragOver = false;
            for (const path of payload.paths) {
              if (extensionAllowed(path)) {
                void openServerPath(path);
                return; // only open the first valid file (folder drag, multi-select)
              }
            }
            console.warn("[useTauriFileDrop] no supported file in drop:", payload.paths);
            return;
          case "leave":
            fileDragOver = false;
            return;
          // case "over": no-op; cursor movement during a drag
        }
      });
    })
    .catch((err) => {
      _initialized = false;
      console.warn("[useTauriFileDrop] Failed to attach onDragDropEvent:", err);
    });
}

/** Test-only: tear down the listener and reset module state. */
export function _resetForTests(): void {
  if (_unlisten) {
    try {
      _unlisten();
    } catch {
      // ignore
    }
    _unlisten = null;
  }
  fileDragOver = false;
  _initialized = false;
}
