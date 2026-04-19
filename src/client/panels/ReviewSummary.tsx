import React from "react";

interface ReviewSummaryProps {
  accepted: number;
  dismissed: number;
  total: number;
  onDismiss: () => void;
}

export function ReviewSummary({ accepted, dismissed, total, onDismiss }: ReviewSummaryProps) {
  const acceptRate = total > 0 ? Math.round((accepted / total) * 100) : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.4)",
        zIndex: 1000,
      }}
      onClick={onDismiss}
    >
      <div
        style={{
          background: "var(--tandem-surface)",
          borderRadius: "12px",
          padding: "32px 40px",
          maxWidth: "400px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
          textAlign: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: "48px", marginBottom: "8px" }}>
          {acceptRate >= 80 ? "\u2705" : acceptRate >= 50 ? "\uD83D\uDCCB" : "\uD83D\uDD0D"}
        </div>
        <h2
          style={{
            margin: "0 0 8px",
            fontSize: "20px",
            fontWeight: 600,
            color: "var(--tandem-fg)",
          }}
        >
          Review Complete
        </h2>
        <p style={{ margin: "0 0 20px", color: "var(--tandem-fg-muted)", fontSize: "14px" }}>
          All annotations have been resolved.
        </p>
        <div
          style={{ display: "flex", justifyContent: "center", gap: "24px", marginBottom: "20px" }}
        >
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "var(--tandem-success)" }}>
              {accepted}
            </div>
            <div style={{ fontSize: "12px", color: "var(--tandem-fg-muted)" }}>Accepted</div>
          </div>
          <div style={{ width: "1px", background: "var(--tandem-border)" }} />
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "var(--tandem-error)" }}>
              {dismissed}
            </div>
            <div style={{ fontSize: "12px", color: "var(--tandem-fg-muted)" }}>Dismissed</div>
          </div>
          <div style={{ width: "1px", background: "var(--tandem-border)" }} />
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "var(--tandem-accent)" }}>
              {acceptRate}%
            </div>
            <div style={{ fontSize: "12px", color: "var(--tandem-fg-muted)" }}>Accept rate</div>
          </div>
        </div>
        <button
          onClick={onDismiss}
          style={{
            padding: "8px 24px",
            fontSize: "14px",
            fontWeight: 500,
            border: "none",
            borderRadius: "6px",
            background: "var(--tandem-accent)",
            color: "var(--tandem-accent-fg)",
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
