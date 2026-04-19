import { useState } from "react";
import { API_BASE } from "../utils/fileUpload";

const DISMISS_KEY = "tandem:reviewOnlyBannerDismissed";

interface ReviewOnlyBannerProps {
  visible: boolean;
  documentId?: string;
}

export function ReviewOnlyBanner({ visible, documentId }: ReviewOnlyBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!visible || dismissed) return null;

  async function handleConvert() {
    if (!documentId || converting) return;
    setConverting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Conversion failed (HTTP ${res.status}).`);
      }
      // On success the server opens the new .md tab — Hocuspocus sync handles the rest
    } catch {
      setError("Could not reach the server.");
    } finally {
      setConverting(false);
    }
  }

  return (
    <div
      data-testid="review-only-banner"
      style={{
        padding: "8px 16px",
        backgroundColor: "var(--tandem-info-bg)",
        borderBottom: "1px solid var(--tandem-info-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "13px",
        color: "var(--tandem-info-fg-strong)",
        gap: "12px",
      }}
    >
      <span>
        This document is open in review-only mode. You can add annotations and review, but cannot
        edit directly.
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        {error && (
          <span
            style={{ color: "var(--tandem-error-fg-strong)", fontSize: "12px", maxWidth: "200px" }}
          >
            {error}
          </span>
        )}
        {documentId && (
          <button
            type="button"
            data-testid="convert-to-markdown-btn"
            onClick={handleConvert}
            disabled={converting}
            style={{
              background: "var(--tandem-info)",
              border: "none",
              color: "var(--tandem-info-fg)",
              cursor: converting ? "default" : "pointer",
              fontWeight: 500,
              fontSize: "12px",
              padding: "4px 10px",
              borderRadius: "4px",
              whiteSpace: "nowrap",
              opacity: converting ? 0.6 : 1,
            }}
          >
            {converting ? "Converting\u2026" : "Convert to Markdown"}
          </button>
        )}
        <button
          type="button"
          data-testid="review-only-dismiss"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, "true");
            } catch {
              // storage unavailable
            }
            setDismissed(true);
          }}
          style={{
            background: "none",
            border: "none",
            color: "var(--tandem-info-fg-strong)",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "13px",
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
