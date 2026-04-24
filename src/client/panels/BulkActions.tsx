import type React from "react";

const SMALL_BTN: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: "11px",
  border: "1px solid var(--tandem-border-strong)",
  borderRadius: "3px",
  cursor: "pointer",
};

interface BulkActionsProps {
  bulkConfirm: "accept" | "dismiss" | null;
  pendingCount: number;
  allPendingCount: number;
  confirmRef: React.RefObject<HTMLButtonElement | null>;
  onConfirmAccept: () => void;
  onConfirmDismiss: () => void;
  onCancel: () => void;
  onRequestAccept: () => void;
  onRequestDismiss: () => void;
}

export function BulkActions({
  bulkConfirm,
  pendingCount,
  allPendingCount,
  confirmRef,
  onConfirmAccept,
  onConfirmDismiss,
  onCancel,
  onRequestAccept,
  onRequestDismiss,
}: BulkActionsProps) {
  if (pendingCount <= 1) return null;

  const isAccept = bulkConfirm === "accept";
  const countLabel =
    pendingCount === allPendingCount
      ? `${pendingCount} annotations?`
      : `${pendingCount} of ${allPendingCount} pending?`;

  return (
    <div
      style={{
        padding: "6px 16px",
        borderBottom: "1px solid var(--tandem-border)",
        display: "flex",
        gap: "6px",
        alignItems: "center",
      }}
    >
      {bulkConfirm ? (
        <>
          <span style={{ fontSize: "11px", color: "var(--tandem-fg)" }}>
            {isAccept ? "Accept" : "Reject"} {countLabel}
          </span>
          <button
            ref={confirmRef}
            data-testid="bulk-confirm-btn"
            onClick={isAccept ? onConfirmAccept : onConfirmDismiss}
            style={{
              ...SMALL_BTN,
              background: isAccept ? "var(--tandem-success-bg)" : "var(--tandem-error-bg)",
              color: isAccept ? "var(--tandem-success-fg-strong)" : "var(--tandem-error-fg-strong)",
              fontWeight: 600,
            }}
          >
            Confirm
          </button>
          <button
            data-testid="bulk-cancel-btn"
            onClick={onCancel}
            style={{
              ...SMALL_BTN,
              background: "var(--tandem-surface)",
              color: "var(--tandem-fg-muted)",
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            data-testid="bulk-accept-btn"
            onClick={onRequestAccept}
            style={{
              ...SMALL_BTN,
              background: "var(--tandem-success-bg)",
              color: "var(--tandem-success-fg-strong)",
            }}
          >
            Accept All ({pendingCount})
          </button>
          <button
            data-testid="bulk-dismiss-btn"
            onClick={onRequestDismiss}
            style={{
              ...SMALL_BTN,
              background: "var(--tandem-error-bg)",
              color: "var(--tandem-error-fg-strong)",
            }}
          >
            Reject All
          </button>
        </>
      )}
    </div>
  );
}
