import { useEffect, useRef, useState } from "react";

export interface AnnotationCardActionsProps {
  annotationId: string;
  isPending: boolean;
  isEditing: boolean;
  undoable?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
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
  const [undoError, setUndoError] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    },
    [],
  );

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
      <div style={{ marginTop: "4px" }}>
        <button
          data-testid="undo-btn"
          onClick={(e) => {
            e.stopPropagation();
            const ok = onUndo(annotationId);
            if (!ok) {
              setUndoError(true);
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
              undoTimerRef.current = setTimeout(() => setUndoError(false), 3000);
            }
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
        {undoError && (
          <div
            style={{
              fontSize: "11px",
              color: "var(--tandem-error-fg)",
              marginTop: "2px",
            }}
          >
            Can't undo — text has changed.
          </div>
        )}
      </div>
    );
  }

  return null;
}
