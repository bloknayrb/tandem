import React, { useState } from "react";
import type { AnnotationReply } from "../../shared/types";
import { CommentThread } from "./CommentThread";

export interface ReplyThreadProps {
  annotationId: string;
  replies: AnnotationReply[];
  isPending: boolean;
  isEditing: boolean;
  textareaStyle: React.CSSProperties;
  onReply?: (id: string, text: string) => Promise<boolean>;
}

export function ReplyThread({
  annotationId,
  replies,
  isPending,
  isEditing,
  textareaStyle,
  onReply,
}: ReplyThreadProps) {
  const [isReplying, setIsReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSendingReply, setIsSendingReply] = useState(false);

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
      const ok = await onReply?.(annotationId, trimmed);
      if (ok !== false) {
        setReplyText("");
        setIsReplying(false);
      }
    } finally {
      setIsSendingReply(false);
    }
  }

  return (
    <>
      {/* Reply thread */}
      <CommentThread replies={replies} />
      {/* Reply input — only on pending annotations with a reply handler */}
      {isPending && onReply && !isEditing && (
        <div style={{ marginTop: "6px" }} onClick={(e) => e.stopPropagation()}>
          {isReplying ? (
            <div>
              <textarea
                data-testid={`reply-input-${annotationId}`}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                placeholder="Write a reply..."
                style={textareaStyle}
                autoFocus
              />
              <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                <button
                  data-testid={`reply-send-btn-${annotationId}`}
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
                  data-testid={`reply-cancel-btn-${annotationId}`}
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
              data-testid={`reply-btn-${annotationId}`}
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
    </>
  );
}
