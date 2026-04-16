import React from "react";
import type { AnnotationReply } from "../../shared/types";

interface CommentThreadProps {
  replies: AnnotationReply[];
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString();
}

export function CommentThread({ replies }: CommentThreadProps) {
  if (replies.length === 0) return null;

  return (
    <div
      data-testid="comment-thread"
      style={{
        marginTop: "6px",
        paddingLeft: "8px",
        borderLeft: "2px solid var(--tandem-border)",
      }}
    >
      {replies.map((reply) => (
        <div
          key={reply.id}
          data-testid={`reply-${reply.id}`}
          style={{
            padding: "4px 0",
            fontSize: "12px",
            lineHeight: "1.4",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "2px",
            }}
          >
            <span
              style={{
                fontWeight: 600,
                fontSize: "11px",
                color:
                  reply.author === "claude" ? "var(--tandem-accent)" : "var(--tandem-fg-muted)",
              }}
            >
              {reply.author === "claude" ? "Claude" : "You"}
            </span>
            <span style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)" }}>
              {reply.editedAt && (
                <span style={{ fontStyle: "italic", marginRight: "4px" }}>(edited)</span>
              )}
              {formatTime(reply.timestamp)}
            </span>
          </div>
          <p style={{ margin: 0, color: "var(--tandem-fg)" }}>{reply.text}</p>
        </div>
      ))}
    </div>
  );
}
