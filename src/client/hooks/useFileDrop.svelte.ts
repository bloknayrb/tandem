import { API_UPLOAD } from "../../shared/api-paths.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { API_BASE, readFileForUpload } from "../utils/fileUpload.js";

export interface FileDropState {
  readonly fileDragOver: boolean;
  handleEditorDragOver: (e: DragEvent) => void;
  handleEditorDragLeave: (e: DragEvent) => void;
  handleEditorDrop: (e: DragEvent) => Promise<void>;
}

/**
 * Svelte 5 port of `useFileDrop`.
 *
 * Manages file drag-and-drop on the editor area.
 * Uploads dropped files to the Tandem server via POST /api/upload.
 */
export function createFileDrop(): FileDropState {
  let fileDragOver = $state(false);

  const handleEditorDragOver = (e: DragEvent) => {
    // In Tauri with dragDropEnabled: true, native drops are routed through
    // useTauriFileDrop. Guard prevents double-overlay-state updates if the
    // WebView also fires HTML5 dragover during native DnD.
    if (isTauriRuntime()) return;
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      fileDragOver = true;
    }
  };

  const handleEditorDragLeave = (e: DragEvent) => {
    if (isTauriRuntime()) return;
    if (
      e.currentTarget === e.target ||
      !(e.currentTarget as Node).contains(e.relatedTarget as Node)
    ) {
      fileDragOver = false;
    }
  };

  const handleEditorDrop = async (e: DragEvent) => {
    if (isTauriRuntime()) return;
    fileDragOver = false;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const content = await readFileForUpload(file);
    try {
      const response = await fetch(`${API_BASE}${API_UPLOAD}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "Upload failed" }));
        console.error(
          "[useFileDrop] Upload failed:",
          response.status,
          (body as Record<string, string>).message ?? (body as Record<string, string>).error,
        );
      }
    } catch {
      console.error("[useFileDrop] Server unreachable — file drop ignored");
    }
  };

  return {
    get fileDragOver() {
      return fileDragOver;
    },
    handleEditorDragOver,
    handleEditorDragLeave,
    handleEditorDrop,
  };
}
