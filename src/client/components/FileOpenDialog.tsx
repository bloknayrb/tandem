import React, { useState, useRef, useCallback } from "react";
import { API_BASE, readFileForUpload } from "../utils/fileUpload";
import {
  addRecentFile,
  clearRecentFiles,
  loadRecentFiles,
  saveRecentFiles,
} from "../utils/recentFiles";

interface FileOpenDialogProps {
  onClose: () => void;
}

type Mode = "path" | "upload";

export function FileOpenDialog({ onClose }: FileOpenDialogProps) {
  const [mode, setMode] = useState<Mode>("path");
  const [filePath, setFilePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);

  const pushRecent = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const updated = addRecentFile(prev, path);
      saveRecentFiles(updated);
      return updated;
    });
  }, []);

  const handleClearRecent = useCallback(() => {
    clearRecentFiles();
    setRecentFiles([]);
  }, []);

  const openByPath = useCallback(
    async (pathToOpen: string) => {
      if (loading) return;
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: pathToOpen }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.message ?? "Failed to open file");
          return;
        }
        pushRecent(pathToOpen);
        onClose();
      } catch (err) {
        console.error("FileOpenDialog: path open failed", err);
        if (err instanceof SyntaxError) {
          setError("Server returned an unexpected response");
        } else if (err instanceof TypeError) {
          setError("Unexpected response format");
        } else {
          setError("Cannot reach server. Is it running?");
        }
      } finally {
        setLoading(false);
      }
    },
    [loading, onClose, pushRecent],
  );

  const handlePathSubmit = useCallback(() => {
    if (!filePath.trim()) return;
    openByPath(filePath.trim());
  }, [filePath, openByPath]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (loading) return;
      setError(null);
      setLoading(true);
      try {
        const content = await readFileForUpload(file);
        const res = await fetch(`${API_BASE}/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, content }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.message ?? "Failed to upload file");
          return;
        }
        onClose();
      } catch (err) {
        console.error("FileOpenDialog: upload failed", err);
        if (err instanceof SyntaxError) {
          setError("Server returned an unexpected response");
        } else if (err instanceof TypeError) {
          setError("Unexpected response format");
        } else {
          setError("Cannot reach server. Is it running?");
        }
      } finally {
        setLoading(false);
      }
    },
    [loading, onClose],
  );

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "80px",
        background: "rgba(0,0,0,0.3)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "8px",
          boxShadow: "0 8px 30px rgba(0,0,0,0.15)",
          width: "440px",
          padding: "20px",
        }}
        data-testid="file-open-dialog"
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "#111827" }}>
            Open File
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              color: "#9ca3af",
            }}
          >
            ×
          </button>
        </div>

        {/* Mode toggle */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          <button
            onClick={() => setMode("path")}
            style={{
              flex: 1,
              padding: "6px",
              fontSize: "13px",
              border: "1px solid #e5e7eb",
              borderRadius: "4px",
              cursor: "pointer",
              background: mode === "path" ? "#6366f1" : "#fff",
              color: mode === "path" ? "#fff" : "#374151",
            }}
          >
            File Path
          </button>
          <button
            onClick={() => setMode("upload")}
            style={{
              flex: 1,
              padding: "6px",
              fontSize: "13px",
              border: "1px solid #e5e7eb",
              borderRadius: "4px",
              cursor: "pointer",
              background: mode === "upload" ? "#6366f1" : "#fff",
              color: mode === "upload" ? "#fff" : "#374151",
            }}
          >
            Upload
          </button>
        </div>

        {mode === "path" ? (
          <div>
            <input
              autoFocus
              type="text"
              placeholder="Paste absolute file path..."
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePathSubmit();
              }}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: "13px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                boxSizing: "border-box",
              }}
              data-testid="file-path-input"
            />
            <button
              onClick={handlePathSubmit}
              disabled={loading || !filePath.trim()}
              style={{
                marginTop: "10px",
                width: "100%",
                padding: "8px",
                fontSize: "13px",
                fontWeight: 500,
                border: "none",
                borderRadius: "4px",
                cursor: loading ? "wait" : "pointer",
                background: loading ? "#9ca3af" : "#6366f1",
                color: "#fff",
                opacity: !filePath.trim() ? 0.5 : 1,
              }}
              data-testid="file-open-submit"
            >
              {loading ? "Opening..." : "Open"}
            </button>

            {/* Recent files */}
            {recentFiles.length > 0 && (
              <div data-testid="recent-files-list" style={{ marginTop: "14px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "6px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#9ca3af",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Recent
                  </span>
                  <button
                    data-testid="clear-recent-files"
                    onClick={handleClearRecent}
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#9ca3af",
                      fontSize: "11px",
                      cursor: "pointer",
                      padding: 0,
                      textDecoration: "underline",
                    }}
                  >
                    Clear all
                  </button>
                </div>
                <div
                  style={{
                    maxHeight: "150px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  }}
                >
                  {recentFiles.map((p, i) => {
                    const parts = p.split(/[/\\]/);
                    const filename = parts.pop() ?? p;
                    const dir = parts.join("/") || "/";
                    return (
                      <button
                        key={p}
                        type="button"
                        data-testid={`recent-file-${i}`}
                        onClick={() => {
                          setFilePath(p);
                          openByPath(p);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          padding: "6px 8px",
                          borderRadius: "4px",
                          cursor: "pointer",
                          textAlign: "left",
                          display: "flex",
                          flexDirection: "column",
                          gap: "1px",
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = "#f3f4f6";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                        }}
                      >
                        <span style={{ fontSize: "13px", color: "#111827" }}>{filename}</span>
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#9ca3af",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: "380px",
                          }}
                        >
                          {dir}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "#6366f1" : "#d1d5db"}`,
              borderRadius: "6px",
              padding: "32px 16px",
              textAlign: "center",
              cursor: loading ? "wait" : "pointer",
              background: dragOver ? "#eef2ff" : "#f9fafb",
              transition: "border-color 0.15s, background 0.15s",
            }}
            data-testid="file-upload-zone"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.html,.htm,.docx"
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <div style={{ fontSize: "13px", color: "#6b7280" }}>
              {loading ? "Uploading..." : "Drop a file here or click to browse"}
            </div>
            <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "6px" }}>
              .md, .txt, .html, .docx
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: "10px",
              padding: "8px 10px",
              fontSize: "12px",
              color: "#991b1b",
              background: "#fef2f2",
              borderRadius: "4px",
              border: "1px solid #fecaca",
            }}
            data-testid="file-open-error"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
