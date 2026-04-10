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
          background: "white",
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
        <h2 style={{ margin: "0 0 8px", fontSize: "20px", fontWeight: 600, color: "#111827" }}>
          Review Complete
        </h2>
        <p style={{ margin: "0 0 20px", color: "#6b7280", fontSize: "14px" }}>
          All annotations have been resolved.
        </p>
        <div
          style={{ display: "flex", justifyContent: "center", gap: "24px", marginBottom: "20px" }}
        >
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "#16a34a" }}>{accepted}</div>
            <div style={{ fontSize: "12px", color: "#6b7280" }}>Accepted</div>
          </div>
          <div style={{ width: "1px", background: "#e5e7eb" }} />
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "#dc2626" }}>{dismissed}</div>
            <div style={{ fontSize: "12px", color: "#6b7280" }}>Dismissed</div>
          </div>
          <div style={{ width: "1px", background: "#e5e7eb" }} />
          <div>
            <div style={{ fontSize: "28px", fontWeight: 700, color: "#6366f1" }}>{acceptRate}%</div>
            <div style={{ fontSize: "12px", color: "#6b7280" }}>Accept rate</div>
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
            background: "#6366f1",
            color: "white",
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
