export interface AnnotationCardActionsProps {
  annotationId: string;
  isPending: boolean;
  isEditing: boolean;
  undoable?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
}

export function AnnotationCardActions({
  annotationId,
  isPending,
  isEditing,
  undoable,
  onAccept,
  onDismiss,
  onUndo,
}: AnnotationCardActionsProps) {
  if (isPending && !isEditing && (onAccept || onDismiss)) {
    return (
      <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
        {onAccept && (
          <button
            data-testid={`accept-btn-${annotationId}`}
            onClick={(e) => {
              e.stopPropagation();
              onAccept(annotationId);
            }}
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              border: "1px solid var(--tandem-border-strong)",
              borderRadius: "3px",
              background: "var(--tandem-success-bg)",
              color: "var(--tandem-success-fg-strong)",
              cursor: "pointer",
            }}
          >
            Accept
          </button>
        )}
        {onDismiss && (
          <button
            data-testid={`dismiss-btn-${annotationId}`}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(annotationId);
            }}
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              border: "1px solid var(--tandem-border-strong)",
              borderRadius: "3px",
              background: "var(--tandem-error-bg)",
              color: "var(--tandem-error-fg-strong)",
              cursor: "pointer",
            }}
          >
            Reject
          </button>
        )}
      </div>
    );
  }

  if (!isPending && undoable && onUndo) {
    return (
      <div style={{ marginTop: "4px", position: "relative" }}>
        <button
          data-testid="undo-btn"
          onClick={(e) => {
            e.stopPropagation();
            onUndo(annotationId);
          }}
          style={{
            padding: "1px 6px",
            fontSize: "11px",
            border: "none",
            background: "none",
            color: "var(--tandem-accent)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          Undo
        </button>
        <div
          data-testid="undo-countdown"
          style={{
            height: "2px",
            marginTop: "2px",
            borderRadius: "1px",
            backgroundColor: "var(--tandem-accent)",
            animation: "undo-countdown-shrink 10s linear forwards",
          }}
        />
        <style>
          {`@keyframes undo-countdown-shrink {
              from { width: 100%; }
              to { width: 0%; }
            }`}
        </style>
      </div>
    );
  }

  return null;
}
