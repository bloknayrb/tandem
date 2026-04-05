import React, { useState } from "react";
import type { Annotation } from "../../shared/types";
import { HIGHLIGHT_COLORS } from "../../shared/constants";

export interface AnnotationCardProps {
  annotation: Annotation;
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
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

/** Parse suggestion content JSON, returning { newText, reason } or null on failure */
function parseSuggestion(content: string): { newText: string; reason: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.newText === "string") {
      return { newText: parsed.newText, reason: parsed.reason || "" };
    }
  } catch {
    // not valid suggestion JSON
  }
  return null;
}

export const AnnotationCard = React.memo(function AnnotationCard({
  annotation,
  isReviewTarget,
  onAccept,
  onDismiss,
  onUndo,
  onEdit,
  undoable,
  onClick,
}: AnnotationCardProps) {
  const borderColor = getBorderColor(annotation);
  const isPending = annotation.status === "pending";

  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editNewText, setEditNewText] = useState("");
  const [editReason, setEditReason] = useState("");

  const isSuggestion = annotation.type === "suggestion";

  function enterEditMode() {
    if (isSuggestion) {
      const parsed = parseSuggestion(annotation.content);
      if (parsed) {
        setEditNewText(parsed.newText);
        setEditReason(parsed.reason);
      } else {
        setEditNewText(annotation.content);
        setEditReason("");
      }
    } else {
      setEditText(annotation.content);
    }
    setIsEditing(true);
  }

  function handleSave() {
    const newContent = isSuggestion
      ? JSON.stringify({ newText: editNewText, reason: editReason })
      : editText;
    onEdit?.(annotation.id, newContent);
    setIsEditing(false);
  }

  function handleCancel() {
    setIsEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      handleCancel();
    }
  }

  const textareaStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 6px",
    fontSize: "12px",
    border: "1px solid #d1d5db",
    borderRadius: "3px",
    resize: "vertical",
    fontFamily: "inherit",
    minHeight: "40px",
    boxSizing: "border-box",
  };

  const editBtnStyle: React.CSSProperties = {
    padding: "1px 4px",
    fontSize: "11px",
    border: "none",
    background: "none",
    color: "#9ca3af",
    cursor: "pointer",
    lineHeight: 1,
  };

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
        <span
          style={{
            fontWeight: 500,
            textTransform: "capitalize",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
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
          {isPending && onEdit && !isReviewTarget && !isEditing && (
            <button
              data-testid={`edit-btn-${annotation.id}`}
              onClick={(e) => {
                e.stopPropagation();
                enterEditMode();
              }}
              style={editBtnStyle}
              title="Edit annotation"
            >
              ✎
            </button>
          )}
        </span>
        <span
          style={{
            fontSize: "11px",
            color: "#9ca3af",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {annotation.editedAt && (
            <span style={{ fontStyle: "italic", fontSize: "10px", color: "#b0b0b0" }}>
              (edited)
            </span>
          )}
          {annotation.author === "claude"
            ? "Claude"
            : annotation.author === "import"
              ? "Imported"
              : "You"}
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
      {isEditing ? (
        <div style={{ marginTop: "4px" }} onClick={(e) => e.stopPropagation()}>
          {isSuggestion ? (
            <>
              <label
                style={{
                  fontSize: "11px",
                  color: "#6b7280",
                  display: "block",
                  marginBottom: "2px",
                }}
              >
                Replacement text
              </label>
              <textarea
                data-testid={`edit-newtext-${annotation.id}`}
                value={editNewText}
                onChange={(e) => setEditNewText(e.target.value)}
                onKeyDown={handleKeyDown}
                style={textareaStyle}
                autoFocus
              />
              <label
                style={{
                  fontSize: "11px",
                  color: "#6b7280",
                  display: "block",
                  marginTop: "4px",
                  marginBottom: "2px",
                }}
              >
                Reason
              </label>
              <textarea
                data-testid={`edit-reason-${annotation.id}`}
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                onKeyDown={handleKeyDown}
                style={textareaStyle}
              />
            </>
          ) : (
            <textarea
              data-testid={`edit-text-${annotation.id}`}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              style={textareaStyle}
              autoFocus
            />
          )}
          <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
            <button
              data-testid={`edit-save-btn-${annotation.id}`}
              onClick={(e) => {
                e.stopPropagation();
                handleSave();
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
              Save
            </button>
            <button
              data-testid={`edit-cancel-btn-${annotation.id}`}
              onClick={(e) => {
                e.stopPropagation();
                handleCancel();
              }}
              style={{
                padding: "2px 8px",
                fontSize: "11px",
                border: "1px solid #d1d5db",
                borderRadius: "3px",
                background: "#fff",
                color: "#6b7280",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, color: "#4b5563", lineHeight: "1.4" }}>
          {annotation.type === "suggestion"
            ? (() => {
                const parsed = parseSuggestion(annotation.content);
                return parsed ? parsed.reason || parsed.newText : annotation.content;
              })()
            : annotation.content || "(no note)"}
        </p>
      )}
      {isPending && !isEditing && (onAccept || onDismiss) && (
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
                background: isSuggestion ? "#f0fdf4" : "#eef2ff",
                color: isSuggestion ? "#166534" : "#1e40af",
                cursor: "pointer",
              }}
            >
              {isSuggestion ? "Accept" : "Acknowledge"}
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
