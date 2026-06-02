// Wiring for the native editor context menu — issue #923.
//
// Attaches a `contextmenu` listener to the Tiptap content DOM and a Tauri
// `context-menu-action` event listener, translating right-clicks into a
// `show_context_menu` invoke and routing emitted action ids back to Tiptap.
//
// Lifecycle (per the Svelte review): this is called from inside the editor's
// creation `$effect` with the *local* editor instance, and the returned
// teardown is invoked before `editor.destroy()`. It must NOT capture the
// reactive `editor` $state. The Tauri `listen()` promise is stored and awaited
// in teardown so a fast doc-switch can't leak a global listener.

import type { Editor } from "@tiptap/core";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import { loadInvoke } from "../../cowork/cowork-invoke";
import { detectContext, normalizePlatform, type Platform } from "./detect";
import { dispatchContextAction } from "./dispatch";
import { type ContextMenuRequest, isContextMenuActionId } from "./types";

export interface ContextMenuHostDeps {
  /** Navigate a link href; MUST re-validate via `isSafeExternalHref`. */
  openHref: (href: string) => void;
  /** Optional platform override (tests); defaults to runtime detection. */
  platform?: Platform;
}

async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null; // permission denied / unavailable — no-op paste
  }
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore — copy is best-effort */
  }
}

/**
 * Install the context menu on `editor`. Returns a teardown that removes both
 * listeners. No-op (returns a noop teardown) outside the Tauri runtime so the
 * npm-install browser distribution keeps its native WebView menu.
 */
export function installContextMenu(editor: Editor, deps: ContextMenuHostDeps): () => void {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const dom = editor.view.dom as HTMLElement;
  const platform =
    deps.platform ??
    normalizePlatform(
      typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "",
    );

  // Sensitive link href captured from the real DOM target at popup time. Stays
  // module-local — never crosses the Tauri IPC boundary (security contract).
  let linkHref: string | null = null;

  const onContextMenu = async (e: MouseEvent) => {
    const targetEl = e.target as HTMLElement | null;
    if (!targetEl) return;

    // Decide whether we own this menu BEFORE touching the selection. On the
    // native-menu path (macOS plain text) we must NOT move the caret — doing so
    // would clear the user's selection and break the native Copy/Look Up the
    // WebView menu is about to show. `hasSelection` here is provisional; it's
    // recomputed below after the selection move for the custom-menu path.
    const req = detectContext({
      targetEl,
      platform,
      hasSelection: false,
      isEditable: editor.isEditable,
    });
    if (!req) return; // native WebView menu — selection untouched

    e.preventDefault();

    // Now that we own the menu: move the PM selection to the click point unless
    // the right-click landed inside an existing selection — right-click doesn't
    // move the caret, so acting on the stale selection would target the wrong
    // place (CRDT review).
    const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (coords) {
      const { from, to } = editor.state.selection;
      if (coords.pos < from || coords.pos > to) {
        editor.commands.setTextSelection(coords.pos);
      }
    }
    req.hasSelection = !editor.state.selection.empty;

    linkHref = targetEl.closest("a[href]")?.getAttribute("href") ?? null;

    if (req.kind === "tableCell") {
      // Table command-capability augmentations live in @tiptap/extension-table,
      // not imported by the pure-.ts program — narrow locally (slash-menu
      // pattern) rather than pulling the extension in at runtime.
      const can = editor.can() as ReturnType<Editor["can"]> & {
        mergeCells: () => boolean;
        splitCell: () => boolean;
      };
      req.canMergeCells = can.mergeCells();
      req.canSplitCell = can.splitCell();
    }

    // Native Cut/Copy/Paste/Select All act on the focused webview selection.
    editor.view.focus();

    try {
      const invoke = await loadInvoke();
      await invoke<void>("show_context_menu", { req: req satisfies ContextMenuRequest });
    } catch {
      /* Tauri unavailable or command error — the native menu was already
         suppressed; nothing more we can do this gesture. */
    }
  };

  dom.addEventListener("contextmenu", onContextMenu);

  // Store the PROMISE (not the resolved fn) so teardown can await it even if
  // the editor is destroyed before listen() resolves (async-ordering race).
  const unlistenP = import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ id?: string }>("context-menu-action", (event) => {
      const id = event.payload?.id;
      if (!isContextMenuActionId(id)) return; // drop unknown/forged ids
      void dispatchContextAction(id, {
        editor,
        openHref: deps.openHref,
        getLinkHref: () => linkHref,
        readClipboardText,
        writeClipboardText,
      });
    }),
  );
  unlistenP.catch(() => {});

  return () => {
    dom.removeEventListener("contextmenu", onContextMenu);
    unlistenP.then((un) => un()).catch(() => {});
  };
}
