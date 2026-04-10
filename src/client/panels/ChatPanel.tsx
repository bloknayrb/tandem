import type { Editor as TiptapEditor } from "@tiptap/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as Y from "yjs";
import { CLAUDE_PRESENCE_COLOR, Y_MAP_CHAT } from "../../shared/constants";
import type { FlatOffset } from "../../shared/positions/types";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { generateMessageId } from "../../shared/utils";
import { flatOffsetToPmPos } from "../positions";

const TYPING_DOT_STYLE: React.CSSProperties = {
  width: "5px",
  height: "5px",
  borderRadius: "50%",
  background: CLAUDE_PRESENCE_COLOR,
};

const TYPING_DOT_DELAYS = [0, 0.2, 0.4];

interface ChatPanelProps {
  ctrlYdoc: Y.Doc | null;
  editor: TiptapEditor | null;
  activeDocId: string | null;
  openDocs: Array<{ id: string; fileName: string }>;
  claudeActive?: boolean;
  claudeStatus?: string | null;
  visible?: boolean;
  capturedAnchor: CapturedAnchor | null;
  onCapturedAnchorChange: (anchor: CapturedAnchor | null) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatPanel({
  ctrlYdoc,
  editor,
  activeDocId,
  openDocs,
  claudeActive,
  claudeStatus,
  visible,
  capturedAnchor,
  onCapturedAnchorChange,
  inputRef: externalInputRef,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Sync local textarea ref to external ref so parent can read its value
  useEffect(() => {
    if (externalInputRef) {
      externalInputRef.current = inputRef.current;
    }
  }, [externalInputRef]);

  // Observe Y.Map('chat') for changes
  useEffect(() => {
    if (!ctrlYdoc) return;
    const chatMap = ctrlYdoc.getMap(Y_MAP_CHAT);

    const observer = () => {
      const msgs: ChatMessage[] = [];
      chatMap.forEach((value) => {
        msgs.push(value as ChatMessage);
      });
      msgs.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      setMessages(msgs);
    };

    chatMap.observe(observer);
    observer(); // Initial load
    return () => chatMap.unobserve(observer);
  }, [ctrlYdoc]);

  // Auto-scroll to bottom on new messages or when typing indicator appears
  const prevClaudeActive = useRef(false);
  useEffect(() => {
    // Skip scroll when indicator disappears (claudeActive toggled false)
    if (!claudeActive && prevClaudeActive.current) {
      prevClaudeActive.current = false;
      return;
    }
    prevClaudeActive.current = !!claudeActive;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, claudeActive]);

  // Scroll to bottom when panel becomes visible (display toggle means scrollIntoView no-ops while hidden)
  useEffect(() => {
    if (visible) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [visible]);

  const sendMessage = useCallback(() => {
    if (!ctrlYdoc || !inputText.trim()) return;
    const chatMap = ctrlYdoc.getMap(Y_MAP_CHAT);

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: inputText.trim(),
      timestamp: Date.now(),
      ...(activeDocId ? { documentId: activeDocId } : {}),
      ...(capturedAnchor ? { anchor: capturedAnchor } : {}),
      read: false,
    };

    chatMap.set(msg.id, msg);
    setInputText("");
    onCapturedAnchorChange(null);
  }, [ctrlYdoc, inputText, activeDocId, capturedAnchor, onCapturedAnchorChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const scrollToAnchor = useCallback(
    (anchor: { from: FlatOffset; to: FlatOffset }, docId?: string) => {
      if (!editor || (docId && docId !== activeDocId)) return;
      try {
        const pmFrom = flatOffsetToPmPos(editor.state.doc, anchor.from);
        const pmTo = flatOffsetToPmPos(editor.state.doc, anchor.to);
        editor.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).scrollIntoView().run();
      } catch (err) {
        // Anchor may be stale after edits — log for debugging
        console.warn(
          "[ChatPanel] Could not scroll to anchor:",
          err instanceof Error ? err.message : err,
        );
      }
    },
    [editor, activeDocId],
  );

  const getDocFileName = (docId?: string) => {
    if (!docId) return null;
    const doc = openDocs.find((d) => d.id === docId);
    return doc?.fileName ?? null;
  };

  const unreadCount = messages.filter((m) => m.author === "claude" && !m.read).length;

  const clearChat = useCallback(async () => {
    try {
      await fetch("/api/chat", { method: "DELETE" });
    } catch (err) {
      console.warn("[ChatPanel] Failed to clear chat:", err);
    }
  }, []);

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#fafafa",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e5e7eb",
          fontWeight: 600,
          fontSize: "14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        Chat
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {unreadCount > 0 && (
            <span
              style={{
                background: "#6366f1",
                color: "white",
                borderRadius: "10px",
                padding: "2px 8px",
                fontSize: "11px",
              }}
            >
              {unreadCount}
            </span>
          )}
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              title="Clear chat history"
              data-testid="clear-chat-btn"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#9ca3af",
                fontSize: "13px",
                padding: "2px 4px",
                lineHeight: 1,
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px", minHeight: 0 }}>
        {messages.length === 0 && (
          <div
            style={{ color: "#9ca3af", fontSize: "13px", textAlign: "center", marginTop: "24px" }}
          >
            No messages yet. Select text and send a message to Claude.
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              marginBottom: "12px",
              padding: "8px 12px",
              borderRadius: "8px",
              background: msg.author === "user" ? "#eef2ff" : "#ffffff",
              border: "1px solid " + (msg.author === "user" ? "#c7d2fe" : "#e5e7eb"),
              fontSize: "13px",
            }}
          >
            {/* Author + doc badge */}
            <div style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: "11px",
                  color: msg.author === "claude" ? "#6366f1" : "#374151",
                  textTransform: "uppercase",
                }}
              >
                {msg.author}
              </span>
              {msg.documentId && (
                <span
                  style={{
                    fontSize: "10px",
                    color: "#6b7280",
                    background: "#f3f4f6",
                    padding: "1px 6px",
                    borderRadius: "4px",
                  }}
                >
                  {getDocFileName(msg.documentId) ?? msg.documentId}
                </span>
              )}
              <span style={{ fontSize: "10px", color: "#9ca3af", marginLeft: "auto" }}>
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            {/* Anchor quote */}
            {msg.anchor && (
              <div
                onClick={() => scrollToAnchor(msg.anchor!, msg.documentId)}
                className="chat-anchor-quote"
                style={{
                  padding: "4px 8px",
                  marginBottom: "6px",
                  borderLeft: "3px solid #c7d2fe",
                  background: "#f5f3ff",
                  fontSize: "12px",
                  color: "#4338ca",
                  cursor: "pointer",
                  borderRadius: "0 4px 4px 0",
                  maxHeight: "60px",
                  overflow: "hidden",
                  transition: "max-height 0.3s ease",
                }}
                title="Click to scroll to this text"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.maxHeight = "500px";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.maxHeight = "60px";
                }}
              >
                {msg.anchor.textSnapshot}
              </div>
            )}

            {/* Message text */}
            {msg.author === "claude" ? (
              <div className="chat-markdown">
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              </div>
            ) : (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.text}</div>
            )}
          </div>
        ))}
        {claudeActive && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: "8px",
              fontSize: "12px",
              color: CLAUDE_PRESENCE_COLOR,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span style={{ display: "inline-flex", gap: "3px" }}>
              {TYPING_DOT_DELAYS.map((delay) => (
                <span
                  key={delay}
                  style={{
                    ...TYPING_DOT_STYLE,
                    animation: `tandem-typing-bounce 1.2s ease-in-out ${delay}s infinite`,
                  }}
                />
              ))}
            </span>
            <span>{claudeStatus ?? "Claude is thinking..."}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Anchor indicator */}
      {capturedAnchor && (
        <div
          style={{
            padding: "4px 12px",
            background: "#eef2ff",
            borderTop: "1px solid #c7d2fe",
            fontSize: "11px",
            color: "#4338ca",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            with selection: &ldquo;{capturedAnchor.textSnapshot.slice(0, 40)}
            {capturedAnchor.textSnapshot.length > 40 ? "..." : ""}&rdquo;
          </span>
          <button
            onClick={() => onCapturedAnchorChange(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#6b7280",
              fontSize: "14px",
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid #e5e7eb",
          display: "flex",
          gap: "8px",
        }}
      >
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Claude..."
          rows={2}
          style={{
            flex: 1,
            padding: "8px",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            fontSize: "13px",
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!inputText.trim()}
          style={{
            padding: "8px 12px",
            background: inputText.trim() ? "#6366f1" : "#d1d5db",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: inputText.trim() ? "pointer" : "default",
            fontSize: "13px",
            fontWeight: 500,
            alignSelf: "flex-end",
          }}
        >
          Send
        </button>
      </div>
      <style>{`
        @keyframes tandem-typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
