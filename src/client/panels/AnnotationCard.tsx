import React, { useState } from "react";
import { HIGHLIGHT_COLORS } from "../../shared/constants";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { CommentThread } from "./CommentThread";

export interface AnnotationCardProps {
  annotation: Annotation;
  replies?: AnnotationReply[];
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
  onReply?: (id: string, text: string) => void;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
}

function getBorderColor(annotation: Annotation): string {
  if (annotation.color) {
    return HIGHLIGHT_COLORS[annotation.color] || "#e5e7eb";
  }
  if (annotation.suggestedText !== undefined) return "#8b5cf6"; // replacement
  if (annotation.directedAt === "claude") return "#6366f1"; // question for Claude
  if (annotation.type === "flag") return "#ef4444";
  return "#3b82f6"; // plain comment
}

export const AnnotationCard = React.memo(function AnnotationCard({
  annotation,
  replies = [],
  isReviewTarget,
  onAccept,
  onDismiss,
  onUndo,
  onEdit,
  onReply,
  undoable,
  onClick,
}: AnnotationCardProps) {
  const borderColor = getBorderColor(annotation);
  const isPending = annotation.status === "pending";

  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editNewText, setEditNewText] = useState("");
  const [editReason, setEditReason] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [replyText, setReplyText] = useState("");

  const hasSuggestedText = annotation.suggestedText !== undefined;

  function enterEditMode() {
    if (hasSuggestedText) {
      setEditNewText(annotation.suggestedText ?? "");
      setEditReason(annotation.content);
    } else {
      setEditText(annotation.content);
    }
    setIsEditing(true);
  }

  function handleSave() {
    // For annotations with suggestedText, we encode both fields back into the
    // content string as JSON so the existing onEdit handler can pass it through.
    // The server-side tandem_editAnnotation now accepts newText/reason params
    // but the client edit path goes through Y.Map.set directly.
    const newContent = hasSuggestedText
      ? JSON.stringify({ suggestedText: editNewText, content: editReason })
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

  function handleReplyKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      setIsReplying(false);
      setReplyText("");
    }
  }

  function handleSendReply() {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply?.(annotation.id, trimmed);
    setReplyText("");
    setIsReplying(false);
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

  const truncatedContent = annotation.content
    ? annotation.content.length > 60
      ? annotation.content.slice(0, 57) + "..."
      : annotation.content
    : "";
  const displayType = hasSuggestedText
    ? "replacement"
    : annotation.directedAt === "claude"
      ? "question"
      : annotation.type;
  const cardLabel = `${displayType} annotation${truncatedContent ? ": " + truncatedContent : ""}, ${annotation.status}`;

  return (
    <div
      onClick={onClick}
      data-testid={`annotation-card-${annotation.id}`}
      role="listitem"
      aria-label={cardLabel}
      aria-current={isReviewTarget ? "true" : undefined}
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
          {displayType}
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
              title="Edit this annotation's content"
            >
              ✎ Edit
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
          {hasSuggestedText ? (
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
        <div style={{ margin: 0, color: "#4b5563", lineHeight: "1.4" }}>
          {hasSuggestedText ? (
            <>
              <div
                data-testid={`suggestion-diff-${annotation.id}`}
                style={{
                  padding: "4px 8px",
                  marginBottom: annotation.content ? "4px" : 0,
                  backgroundColor: "#f9fafb",
                  borderRadius: "3px",
                  fontSize: "12px",
                  lineHeight: "1.5",
                }}
              >
                {annotation.textSnapshot && (
                  <span
                    style={{
                      textDecoration: "line-through",
                      color: "#dc2626",
                      backgroundColor: "#fef2f2",
                      padding: "0 2px",
                      borderRadius: "2px",
                    }}
                  >
                    {annotation.textSnapshot}
                  </span>
                )}
                {annotation.textSnapshot && " → "}
                <span
                  style={{
                    color: "#166534",
                    backgroundColor: "#f0fdf4",
                    padding: "0 2px",
                    borderRadius: "2px",
                  }}
                >
                  {annotation.suggestedText}
                </span>
              </div>
              {annotation.content && (
                <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>
                  {annotation.content}
                </p>
              )}
            </>
          ) : (
            <p style={{ margin: 0 }}>{annotation.content || "(no note)"}</p>
          )}
        </div>
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
                background: "#f0fdf4",
                color: "#166534",
                cursor: "pointer",
              }}
            >
              {hasSuggestedText ? "Accept" : "Acknowledge"}
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
        <div style={{ marginTop: "4px", position: "relative" }}>
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
          <div
            data-testid="undo-countdown"
            style={{
              height: "2px",
              marginTop: "2px",
              borderRadius: "1px",
              backgroundColor: "#6366f1",
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
      )}
      {/* Reply thread */}
      <CommentThread replies={replies} />
      {/* Reply input — only on pending annotations with a reply handler */}
      {isPending && onReply && !isEditing && (
        <div style={{ marginTop: "6px" }} onClick={(e) => e.stopPropagation()}>
          {isReplying ? (
            <div>
              <textarea
                data-testid={`reply-input-${annotation.id}`}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                placeholder="Write a reply..."
                style={textareaStyle}
                autoFocus
              />
              <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                <button
                  data-testid={`reply-send-btn-${annotation.id}`}
                  onClick={handleSendReply}
                  disabled={!replyText.trim()}
                  style={{
                    padding: "2px 8px",
                    fontSize: "11px",
                    border: "1px solid #d1d5db",
                    borderRadius: "3px",
                    background: replyText.trim() ? "#eef2ff" : "#f3f4f6",
                    color: replyText.trim() ? "#4338ca" : "#9ca3af",
                    cursor: replyText.trim() ? "pointer" : "default",
                  }}
                >
                  Send
                </button>
                <button
                  data-testid={`reply-cancel-btn-${annotation.id}`}
                  onClick={() => {
                    setIsReplying(false);
                    setReplyText("");
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
            <button
              data-testid={`reply-btn-${annotation.id}`}
              onClick={() => setIsReplying(true)}
              style={{
                padding: "1px 4px",
                fontSize: "11px",
                border: "none",
                background: "none",
                color: "#9ca3af",
                cursor: "pointer",
              }}
            >
              Reply{replies.length > 0 ? ` (${replies.length})` : ""}
            </button>
          )}
        </div>
      )}
      {/* Read-only reply count for resolved annotations */}
      {!isPending && replies.length > 0 && !onReply && (
        <div style={{ marginTop: "4px", fontSize: "11px", color: "#9ca3af" }}>
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
      )}
    </div>
  );
});
