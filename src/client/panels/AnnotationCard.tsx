import React, { useState } from "react";
import { HIGHLIGHT_COLORS } from "../../shared/constants";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { AnnotationCardActions } from "./AnnotationCardActions";
import { AnnotationEditForm } from "./AnnotationEditForm";
import { ReplyThread } from "./ReplyThread";

export const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  fontSize: "12px",
  border: "1px solid var(--tandem-border-strong)",
  borderRadius: "3px",
  resize: "vertical",
  fontFamily: "inherit",
  minHeight: "40px",
  boxSizing: "border-box",
  background: "var(--tandem-surface)",
  color: "var(--tandem-fg)",
};

const EDIT_BTN_STYLE: React.CSSProperties = {
  padding: "1px 4px",
  fontSize: "11px",
  border: "none",
  background: "none",
  color: "var(--tandem-fg-subtle)",
  cursor: "pointer",
  lineHeight: 1,
};

export interface AnnotationCardProps {
  annotation: Annotation;
  replies?: AnnotationReply[];
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
  onEdit?: (id: string, newContent: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  onRemove?: (id: string) => void;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
}

function getDisplayType(annotation: Annotation): string {
  if (annotation.suggestedText !== undefined) return "replacement";
  if (annotation.directedAt === "claude") return "question";
  return annotation.type;
}

function getAuthorLabel(author: Annotation["author"]): string {
  if (author === "claude") return "Claude";
  if (author === "import") return "Imported";
  return "You";
}

function getBorderColor(annotation: Annotation): string {
  if (annotation.color) {
    return HIGHLIGHT_COLORS[annotation.color] || "var(--tandem-border)";
  }
  if (annotation.suggestedText !== undefined) return "var(--tandem-suggestion)"; // replacement
  if (annotation.directedAt === "claude") return "var(--tandem-accent)"; // question for Claude
  if (annotation.type === "flag") return "var(--tandem-error)";
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
  onRemove,
  undoable,
  onClick,
}: AnnotationCardProps) {
  const borderColor = getBorderColor(annotation);
  const isPending = annotation.status === "pending";

  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editNewText, setEditNewText] = useState("");
  const [editReason, setEditReason] = useState("");

  const hasSuggestedText = annotation.suggestedText !== undefined;
  const displayType = getDisplayType(annotation);

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

  const truncatedContent = annotation.content
    ? annotation.content.length > 60
      ? annotation.content.slice(0, 57) + "..."
      : annotation.content
    : "";
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
              style={EDIT_BTN_STYLE}
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
          {getAuthorLabel(annotation.author)}
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
        <AnnotationEditForm
          annotationId={annotation.id}
          hasSuggestedText={hasSuggestedText}
          editText={editText}
          editNewText={editNewText}
          editReason={editReason}
          onChangeEditText={setEditText}
          onChangeEditNewText={setEditNewText}
          onChangeEditReason={setEditReason}
          onKeyDown={handleKeyDown}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      ) : (
        <div style={{ margin: 0, color: "var(--tandem-fg)", lineHeight: "1.4" }}>
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
                      backgroundColor: "var(--tandem-error-bg)",
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
                    color: "var(--tandem-success-fg-strong)",
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
      <AnnotationCardActions
        annotationId={annotation.id}
        isPending={isPending}
        isEditing={isEditing}
        undoable={undoable}
        onAccept={onAccept}
        onDismiss={onDismiss}
        onUndo={onUndo}
        onRemove={onRemove}
      />
      <ReplyThread
        annotationId={annotation.id}
        replies={replies}
        isPending={isPending}
        isEditing={isEditing}
        onReply={onReply}
      />
    </div>
  );
});
