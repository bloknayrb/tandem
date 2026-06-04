// Shared wiring for the native annotation-card context menu — issue #999 (#923 Phase 3).
//
// Unlike Phase 1/2 (component-local gesture state), the annotation menu spans TWO surfaces
// that can be mounted SIMULTANEOUSLY — the right rail (`SidePanel`) and the margin view
// (`MarginColumn`). Two independent `context-menu-action` listeners would double-dispatch,
// so the gesture state and the Tauri listener are hoisted here:
//
//   - `currentGesture` — a module-level singleton (plain `let`, NOT $state — pure gesture
//     bookkeeping, like `ctxTabId` in DocumentTabs). Holds ONE atomic `run(id)` closure
//     that binds the right-clicked annotation id + the originating panel's handlers
//     together. Overwritten wholesale on each right-click; the OS popup is modal so only
//     one gesture is ever live (last-writer-wins).
//   - `subscribeAnnotationActions()` — refcounted single `listen("context-menu-action")`.
//     First subscriber creates it; last unsubscribe tears it down. Each teardown is
//     idempotent (`disposed` flag) so a double cleanup can't underflow the refcount and
//     prematurely unlisten while the other panel is still mounted (→ silent dead menu).
//
// The annotation id never crosses the Tauri IPC boundary — it stays captured in `run`.

import type { Annotation } from "../../shared/types";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { loadInvoke } from "../cowork/cowork-invoke";
import {
  type AnnotationContextMenuActionId,
  buildAnnotationMenuContext,
  canAccept,
  canCopy,
  canDismiss,
  canEdit,
  canRemove,
  canReply,
  canSendToClaude,
  copyTextFor,
  isAnnotationContextMenuActionId,
} from "./annotation-context-menu";

/** The live gesture: its `run` is bound to the most-recent right-click's id + handlers. */
interface AnnotationGesture {
  run: (id: AnnotationContextMenuActionId) => void | Promise<void>;
}

let currentGesture: AnnotationGesture | null = null;

/**
 * Record the gesture for the just-opened menu. Called synchronously by a panel's
 * `contextmenu` handler immediately before it invokes `show_annotation_context_menu`.
 * Overwrites any prior gesture wholesale (last-writer-wins; modal popup ⇒ one live).
 */
export function setAnnotationGesture(gesture: AnnotationGesture): void {
  currentGesture = gesture;
}

/**
 * Per-panel action handlers. Accept/dismiss/sendToClaude/remove map to the panel's
 * existing mutation handlers; openEdit/openReply open the in-card editor/composer (via the
 * reactive `openRequest` nonce the panel owns). Copy is handled internally (identical on
 * both surfaces). All handlers are optional so a surface that doesn't wire one is a no-op.
 */
export interface AnnotationActionHandlers {
  accept?: (id: string) => void;
  dismiss?: (id: string) => void;
  sendToClaude?: (id: string) => void;
  remove?: (id: string) => void;
  openEdit?: (id: string) => void;
  openReply?: (id: string) => void;
}

/**
 * Route an emitted action id to its handler, RE-VALIDATING against the passed live
 * annotation (the right-click snapshot is never trusted — the modal popup can be held open
 * across a status change). Defined ONCE so the two panels can't drift on the gate logic.
 * `remove`'s underlying handler is a fire-and-forget POST with no client gate, so the
 * `canRemove` re-check here IS the client-side gate (the server is author/status-agnostic).
 */
export function runAnnotationAction(
  action: AnnotationContextMenuActionId,
  ann: Annotation,
  handlers: AnnotationActionHandlers,
): void {
  switch (action) {
    case "ctx:annotation:accept":
      if (canAccept(ann)) handlers.accept?.(ann.id);
      return;
    case "ctx:annotation:dismiss":
      if (canDismiss(ann)) handlers.dismiss?.(ann.id);
      return;
    case "ctx:annotation:sendToClaude":
      if (canSendToClaude(ann)) handlers.sendToClaude?.(ann.id);
      return;
    case "ctx:annotation:remove":
      if (canRemove(ann)) handlers.remove?.(ann.id);
      return;
    case "ctx:annotation:edit":
      if (canEdit(ann)) handlers.openEdit?.(ann.id);
      return;
    case "ctx:annotation:reply":
      if (canReply(ann)) handlers.openReply?.(ann.id);
      return;
    case "ctx:annotation:copy":
      if (canCopy(ann)) {
        const text = copyTextFor(ann);
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
      }
      return;
  }
}

/**
 * Record the gesture for `ann` and pop the native menu. The `run` closure must capture the
 * annotation ID only (never the object) and re-resolve live state — see
 * `runAnnotationAction`. No-op-safe: a Tauri/command error leaves the already-suppressed
 * native menu and nothing more to do this gesture.
 */
export async function openAnnotationContextMenu(
  ann: Annotation,
  run: (action: AnnotationContextMenuActionId) => void,
): Promise<void> {
  setAnnotationGesture({ run });
  try {
    const invoke = await loadInvoke();
    await invoke("show_annotation_context_menu", { req: buildAnnotationMenuContext(ann) });
  } catch {
    /* Tauri unavailable or command error — native menu already suppressed. */
  }
}

let refCount = 0;
let unlistenP: Promise<() => void> | null = null;

/**
 * Subscribe to the shared annotation `context-menu-action` listener. Refcounted: the
 * first subscriber lazily creates the single Tauri listener; the returned teardown
 * decrements and removes it at zero. No-op outside the Tauri runtime (browser keeps its
 * native WebView menu). Returns an idempotent unsubscribe.
 */
export function subscribeAnnotationActions(): () => void {
  if (!isTauriRuntime()) return () => {};

  refCount++;
  if (refCount === 1) {
    // Store the PROMISE (not the resolved fn) so teardown can await it even if the last
    // panel unmounts before listen() resolves (async-ordering race; mirrors install.ts).
    unlistenP = import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ id?: string }>("context-menu-action", (event) => {
        const id = event.payload?.id;
        if (!isAnnotationContextMenuActionId(id)) return; // editor/tab ids handled elsewhere
        // Null-guard: a forged event with no preceding right-click has no gesture.
        currentGesture?.run(id);
      }),
    );
    unlistenP.catch(() => {});
  }

  // Per-subscription idempotency guard. Svelte can invoke an $effect teardown more than
  // once (HMR / fast remount); without this the refcount could underflow and tear the
  // listener down while the other panel is still mounted.
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    refCount--;
    if (refCount === 0) {
      const p = unlistenP;
      unlistenP = null;
      p?.then((un) => un()).catch(() => {});
    }
  };
}

/** Test-only reset of the module singletons. */
export function __resetAnnotationContextMenuHostForTest(): void {
  currentGesture = null;
  refCount = 0;
  unlistenP = null;
}
