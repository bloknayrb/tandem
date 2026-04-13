import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_MCP_PORT } from "../../shared/constants";

/**
 * Ctrl+S / Cmd+S keyboard shortcut that saves the active document to disk.
 * Calls POST /api/save on the Tandem server.
 *
 * Returns `saving` boolean for UI feedback.
 */
export function useSaveShortcut(activeDocId: string | null): {
  saving: boolean;
  triggerSave: () => void;
} {
  const [saving, setSaving] = useState(false);
  const inflightRef = useRef(false);

  const triggerSave = useCallback(async () => {
    if (!activeDocId || inflightRef.current) return;
    inflightRef.current = true;
    setSaving(true);

    try {
      const resp = await fetch(`http://localhost:${DEFAULT_MCP_PORT}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: activeDocId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        console.warn("[Tandem] Save failed:", body.message ?? resp.statusText);
      }
    } catch (err) {
      console.warn("[Tandem] Save request failed:", err);
    } finally {
      inflightRef.current = false;
      setSaving(false);
    }
  }, [activeDocId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        triggerSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [triggerSave]);

  return { saving, triggerSave };
}
