import { onDestroy, onMount } from "svelte";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";

export interface SaveShortcutState {
  readonly saving: boolean;
  triggerSave: () => Promise<void>;
}

/**
 * Svelte 5 port of `useSaveShortcut`.
 *
 * Returns `saving` reactive state and a `triggerSave` method.
 * Accepts a getter for `activeDocId` so changes propagate without
 * re-creating the factory.
 */
export function createSaveShortcut(getActiveDocId: () => string | null): SaveShortcutState {
  let saving = $state(false);
  let inflight = false;

  const triggerSave = async () => {
    const activeDocId = getActiveDocId();
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
  };

  let handler: ((e: KeyboardEvent) => void) | null = null;

  onMount(() => {
    handler = (e: KeyboardEvent) => {
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void triggerSave();
      }
    };
    window.addEventListener("keydown", handler);
  });

  onDestroy(() => {
    if (handler) window.removeEventListener("keydown", handler);
  });

  return {
    get saving() {
      return saving;
    },
    triggerSave,
  };
}
