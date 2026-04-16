import React, { useState } from "react";
import { HIGHLIGHT_COLORS } from "../../shared/constants";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { errorStateColors } from "../utils/colors";
import { CommentThread } from "./CommentThread";

export interface AnnotationCardProps {
  annotation: Annotation;
  replies?: AnnotationReply[];
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
}

function getBorderColor(annotation: Annotation): string {
  if (annotation.color) {
    return HIGHLIGHT_COLORS[annotation.color] || "var(--tandem-border)";
  }
  if (annotation.suggestedText !== undefined) return "#8b5cf6"; // replacement
  if (annotation.directedAt === "claude") return "var(--tandem-accent)"; // question for Claude
  if (annotation.type === "flag") return "#ef4444";
  return "var(--tandem-author-user)"; // plain comment
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
  const [isSendingReply, setIsSendingReply] = useState(false);

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

  async function handleSendReply() {
    const trimmed = replyText.trim();
    if (!trimmed || isSendingReply) return;
    setIsSendingReply(true);
    try {
      const ok = await onReply?.(annotation.id, trimmed);
      if (ok !== false) {
        setReplyText("");
        setIsReplying(false);
      }
    } finally {
      setIsSendingReply(false);
    }
  }

  const textareaStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 6px",
    fontSize: "12px",
    border: "1px solid var(--tandem-border-strong)",
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
    color: "var(--tandem-fg-subtle)",
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
        background: isReviewTarget ? "var(--tandem-accent-bg)" : "var(--tandem-surface)",
        borderRadius: "0 4px 4px 0",
        fontSize: "13px",
        opacity: isPending ? 1 : 0.6,
        cursor: onClick ? "pointer" : "default",
        outline: isReviewTarget ? "2px solid var(--tandem-accent)" : "none",
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
                color:
                  annotation.status === "accepted"
                    ? "var(--tandem-success)"
                    : "var(--tandem-error)",
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
            color: "var(--tandem-fg-subtle)",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {annotation.editedAt && (
            <span
              style={{ fontStyle: "italic", fontSize: "10px", color: "var(--tandem-fg-subtle)" }}
            >
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
            borderLeft: "3px solid var(--tandem-border-strong)",
            color: "var(--tandem-fg-muted)",
            fontSize: "12px",
            fontStyle: "italic",
            backgroundColor: "var(--tandem-surface-muted)",
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
                  color: "var(--tandem-fg-muted)",
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
                  color: "var(--tandem-fg-muted)",
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
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: "3px",
                background: "var(--tandem-success-bg)",
                color: "var(--tandem-success)",
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
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: "3px",
                background: "var(--tandem-surface)",
                color: "var(--tandem-fg-muted)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ margin: 0, color: "var(--tandem-fg-muted)", lineHeight: "1.4" }}>
          {hasSuggestedText ? (
            <>
              <div
                data-testid={`suggestion-diff-${annotation.id}`}
                style={{
                  padding: "4px 8px",
                  marginBottom: annotation.content ? "4px" : 0,
                  backgroundColor: "var(--tandem-surface-muted)",
                  borderRadius: "3px",
                  fontSize: "12px",
                  lineHeight: "1.5",
                }}
              >
                {annotation.textSnapshot && (
                  <span
                    style={{
                      textDecoration: "line-through",
                      color: "var(--tandem-error)",
                      backgroundColor: errorStateColors.background,
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
                    color: "var(--tandem-success)",
                    backgroundColor: "var(--tandem-success-bg)",
                    padding: "0 2px",
                    borderRadius: "2px",
                  }}
                >
                  {annotation.suggestedText}
                </span>
              </div>
              {annotation.content && (
                <p style={{ margin: 0, fontSize: "12px", color: "var(--tandem-fg-muted)" }}>
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
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: "3px",
                background: "var(--tandem-success-bg)",
                color: "var(--tandem-success)",
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
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: "3px",
                background: errorStateColors.background,
                color: "var(--tandem-error)",
                cursor: "pointer",
              }}
            >
              Reject
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
                  disabled={!replyText.trim() || isSendingReply}
                  style={{
                    padding: "2px 8px",
                    fontSize: "11px",
                    border: "1px solid var(--tandem-border-strong)",
                    borderRadius: "3px",
                    background: replyText.trim()
                      ? "var(--tandem-accent-bg)"
                      : "var(--tandem-surface-muted)",
                    color: replyText.trim()
                      ? "var(--tandem-accent-fg-strong)"
                      : "var(--tandem-fg-subtle)",
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
                    border: "1px solid var(--tandem-border-strong)",
                    borderRadius: "3px",
                    background: "var(--tandem-surface)",
                    color: "var(--tandem-fg-muted)",
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
                color: "var(--tandem-fg-subtle)",
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
        <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--tandem-fg-subtle)" }}>
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
      )}
    </div>
  );
});
