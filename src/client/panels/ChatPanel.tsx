import { Y_MAP_CHAT } from "../../shared/constants";
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import ReactMarkdown from "react-markdown";
import * as Y from "yjs";
import { pmPosToFlatOffset, flatOffsetToPmPos } from "../positions";
import { generateMessageId } from "../../shared/utils";
import type { ChatMessage } from "../../shared/types";

interface ChatPanelProps {
  ctrlYdoc: Y.Doc | null;
  editor: TiptapEditor | null;
  activeDocId: string | null;
  openDocs: Array<{ id: string; fileName: string }>;
}

export function ChatPanel({ ctrlYdoc, editor, activeDocId, openDocs }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [capturedAnchor, setCapturedAnchor] = useState<{
    from: number;
    to: number;
    textSnapshot: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Capture selection on mousedown of send button (before editor loses focus)
  const captureSelection = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      setCapturedAnchor(null);
      return;
    }
    const flatFrom = pmPosToFlatOffset(editor.state.doc, from);
    const flatTo = pmPosToFlatOffset(editor.state.doc, to);
    const text = editor.state.doc.textBetween(from, to, "\n");
    setCapturedAnchor({
      from: flatFrom,
      to: flatTo,
      textSnapshot: text.length > 200 ? text.slice(0, 197) + "..." : text,
    });
  }, [editor]);

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
    setCapturedAnchor(null);
  }, [ctrlYdoc, inputText, activeDocId, capturedAnchor]);

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
    (anchor: { from: number; to: number }, docId?: string) => {
      if (!editor || (docId && docId !== activeDocId)) return;
      try {
        const pmFrom = flatOffsetToPmPos(editor.state.doc, anchor.from);
        const pmTo = flatOffsetToPmPos(editor.state.doc, anchor.to);
        editor.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).scrollIntoView().run();
      } catch {
        // Anchor may be stale — ignore silently
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
                }}
                title="Click to scroll to this text"
              >
                {msg.anchor.textSnapshot.slice(0, 80)}
                {msg.anchor.textSnapshot.length > 80 ? "..." : ""}
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
            onClick={() => setCapturedAnchor(null)}
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
          onMouseDown={captureSelection}
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
    </div>
  );
}
