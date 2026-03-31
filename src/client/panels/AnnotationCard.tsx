import React from "react";
import type { Annotation } from "../../shared/types";
import { HIGHLIGHT_COLORS } from "../../shared/constants";

export interface AnnotationCardProps {
  annotation: Annotation;
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
}

const ANNOTATION_BORDER_COLORS: Record<string, string> = {
  comment: "#3b82f6",
  suggestion: "#8b5cf6",
  question: "#6366f1",
  flag: "#ef4444",
};

function getBorderColor(annotation: Annotation): string {
  if (annotation.color) {
    return HIGHLIGHT_COLORS[annotation.color] || "#e5e7eb";
  }
  return ANNOTATION_BORDER_COLORS[annotation.type] || "#e5e7eb";
}

export const AnnotationCard = React.memo(function AnnotationCard({
  annotation,
  isReviewTarget,
  onAccept,
  onDismiss,
  onUndo,
  undoable,
  onClick,
}: AnnotationCardProps) {
  const borderColor = getBorderColor(annotation);

  const isPending = annotation.status === "pending";

  return (
    <div
      onClick={onClick}
      data-testid={`annotation-card-${annotation.id}`}
      style={{
        padding: "8px 10px",
        marginBottom: "6px",
        borderLeft: `3px solid ${borderColor}`,
        background: isReviewTarget ? "#eef2ff" : "white",
        borderRadius: "0 4px 4px 0",
        fontSize: "13px",
        opacity: isPending ? 1 : 0.6,
        cursor: onClick ? "pointer" : "default",
        outline: isReviewTarget ? "2px solid #6366f1" : "none",
        transition: "background 0.15s, outline 0.15s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontWeight: 500, textTransform: "capitalize" }}>
          {annotation.type}
          {!isPending && (
            <span
              style={{
                marginLeft: "6px",
                fontSize: "10px",
                color: annotation.status === "accepted" ? "#16a34a" : "#dc2626",
                fontWeight: 600,
              }}
            >
              {annotation.status}
            </span>
          )}
        </span>
        <span style={{ fontSize: "11px", color: "#9ca3af" }}>
          {annotation.author === "claude" ? "Claude" : "You"}
        </span>
      </div>
      {annotation.textSnapshot && (
        <div
          data-testid={`annotation-snippet-${annotation.id}`}
          style={{
            padding: "4px 8px",
            marginBottom: "6px",
            borderLeft: "3px solid #d1d5db",
            color: "#6b7280",
            fontSize: "12px",
            fontStyle: "italic",
            backgroundColor: "#f9fafb",
            borderRadius: "2px",
          }}
        >
          {annotation.textSnapshot.length > 80
            ? annotation.textSnapshot.slice(0, 77) + "..."
            : annotation.textSnapshot}
        </div>
      )}
      <p style={{ margin: 0, color: "#4b5563", lineHeight: "1.4" }}>
        {annotation.type === "suggestion"
          ? (() => {
              try {
                const parsed = JSON.parse(annotation.content);
                return parsed.reason || parsed.newText;
              } catch {
                return annotation.content;
              }
            })()
          : annotation.content || "(no note)"}
      </p>
      {isPending && (onAccept || onDismiss) && (
        <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
          {onAccept && (
            <button
              data-testid={`accept-btn-${annotation.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onAccept(annotation.id);
              }}
              style={{
                padding: "2px 8px",
                fontSize: "11px",
                border: "1px solid #d1d5db",
                borderRadius: "3px",
                background: "#f0fdf4",
                color: "#166534",
                cursor: "pointer",
              }}
            >
              Accept
            </button>
          )}
          {onDismiss && (
            <button
              data-testid={`dismiss-btn-${annotation.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(annotation.id);
              }}
              style={{
                padding: "2px 8px",
                fontSize: "11px",
                border: "1px solid #d1d5db",
                borderRadius: "3px",
                background: "#fef2f2",
                color: "#991b1b",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {!isPending && undoable && onUndo && (
        <div style={{ marginTop: "4px" }}>
          <button
            data-testid="undo-btn"
            onClick={(e) => {
              e.stopPropagation();
              onUndo(annotation.id);
            }}
            style={{
              padding: "1px 6px",
              fontSize: "11px",
              border: "none",
              background: "none",
              color: "#6366f1",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
});
