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
 * Failure modes (server error, dynamic-import failure, unsupported file,
 * runtime exception in the listener) all surface through the caller-provided
 * `push` callback so users see a toast instead of a console line they will
 * never read. `push` is required by the type system so a future refactor
 * that drops the App.svelte wiring becomes a compile error rather than a
 * silent UX regression.
 *
 * Mirrors `useTauriTheme.svelte.ts` in shape: module-level singleton state,
 * idempotent init, HMR-safe disposal, `_resetForTests()` for unit-test
 * isolation.
 */
import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
import type { TandemNotification } from "../../shared/types.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { openServerPath } from "../utils/server-paths.js";

let fileDragOver = $state(false);
let _initialized = false;
let _unlisten: (() => void) | null = null;
let _disposed = false;
let _notify: (n: TandemNotification) => void = () => {};

export const tauriFileDrop = {
  get fileDragOver() {
    return fileDragOver;
  },
};

function extensionAllowed(path: string): boolean {
  const basename = path.split(/[/\\]/).at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false; // ≤ 0: no extension or leading-dot dotfiles (.md, .bashrc)
  return SUPPORTED_EXTENSIONS.has(basename.slice(dot).toLowerCase());
}

// Derived once at module load so the unsupported-drop toast lists exactly
// what SUPPORTED_EXTENSIONS contains — no hand-maintained duplicate that
// can drift (the original literal omitted .htm; caught in 8e73059).
const SUPPORTED_EXTENSION_LIST = (() => {
  const exts = Array.from(SUPPORTED_EXTENSIONS).sort();
  if (exts.length <= 1) return exts[0] ?? "";
  if (exts.length === 2) return `${exts[0]} or ${exts[1]}`;
  return `${exts.slice(0, -1).join(", ")}, or ${exts.at(-1)}`;
})();

function toast(message: string, severity: TandemNotification["severity"], dedupKey: string): void {
  _notify({
    id: `tauri-drop-${dedupKey}-${Date.now()}`,
    type: "general-error",
    severity,
    message,
    dedupKey,
    timestamp: Date.now(),
  });
}

export function initTauriFileDrop(push: (n: TandemNotification) => void): void {
  _notify = push;
  if (_initialized) return;
  if (!isTauriRuntime()) return;
  _initialized = true;

  import("@tauri-apps/api/webview")
    .then(async ({ getCurrentWebview }) => {
      const unlistenFn = await getCurrentWebview().onDragDropEvent((event) => {
        try {
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
                  void (async () => {
                    const result = await openServerPath(path);
                    if (!result.ok) {
                      toast(
                        `Couldn't open ${path}: ${result.error}`,
                        "error",
                        "tauri-drop-open-failed",
                      );
                    }
                  })();
                  return; // only open the first valid file (folder drag, multi-select)
                }
              }
              toast(
                `Tandem can only open ${SUPPORTED_EXTENSION_LIST} files`,
                "warning",
                "tauri-drop-unsupported",
              );
              return;
            case "leave":
              fileDragOver = false;
              return;
            // case "over": no-op; cursor movement during a drag
            default:
              console.warn("[useTauriFileDrop] unknown payload type:", payload);
          }
        } catch (err) {
          console.error("[useTauriFileDrop] callback threw:", err);
          toast(
            "Drag-and-drop encountered an error — try the Open File dialog",
            "error",
            "tauri-drop-callback-error",
          );
        }
      });
      if (_disposed) {
        // HMR fired between init and import resolution — tear down the
        // listener immediately so the next module instance owns DnD.
        try {
          unlistenFn();
        } catch {
          // ignore
        }
        return;
      }
      _unlisten = unlistenFn;
    })
    .catch((err) => {
      _initialized = false;
      console.error("[useTauriFileDrop] Failed to attach onDragDropEvent:", err);
      toast(
        "Drag-and-drop unavailable — use the Open File dialog instead",
        "warning",
        "tauri-drop-unavailable",
      );
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
  _notify = () => {};
}

// Vite HMR: dispose any in-flight or active listener so a re-evaluated
// module doesn't stack a second `onDragDropEvent` callback on top of the
// previous one. Without this, every save during `cargo tauri dev` adds
// another listener and drops fire N+1 times. The `_disposed` flag also
// handles the race where HMR fires before the dynamic import resolves
// (the `.then` checks it before storing `_unlisten`). Production builds
// strip `import.meta.hot`.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposed = true;
    if (_unlisten) {
      try {
        _unlisten();
      } catch {
        // ignore
      }
      _unlisten = null;
    }
    _initialized = false;
    _notify = () => {};
  });
}
