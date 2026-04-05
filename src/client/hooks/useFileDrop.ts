import { useState, useCallback, type DragEvent } from "react";
import { API_BASE, readFileForUpload } from "../utils/fileUpload";

/**
 * Manages file drag-and-drop on the editor area.
 * Uploads dropped files to the Tandem server via POST /api/upload.
 */
export function useFileDrop() {
  const [fileDragOver, setFileDragOver] = useState(false);

  const handleEditorDragOver = useCallback((e: DragEvent) => {
    // Only show drop indicator for file drops, not editor content drags
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setFileDragOver(true);
    }
  }, []);

  const handleEditorDragLeave = useCallback((e: DragEvent) => {
    // Only reset if leaving the wrapper (not entering a child)
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setFileDragOver(false);
    }
  }, []);

  const handleEditorDrop = useCallback(async (e: DragEvent) => {
    setFileDragOver(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const content = await readFileForUpload(file);
    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "Upload failed" }));
        console.error("[useFileDrop] Upload failed:", response.status, body.message ?? body.error);
      }
    } catch {
      console.error("[useFileDrop] Server unreachable — file drop ignored");
    }
  }, []);

  return {
    fileDragOver,
    handleEditorDragOver,
    handleEditorDragLeave,
    handleEditorDrop,
  };
}
