import React, { useEffect, useRef, useState } from "react";
import { CLAUDE_PRESENCE_COLOR, USER_NAME_MAX_LEN } from "../../shared/constants";
import { useUserName } from "../hooks/useUserName";
import type { ConnectionStatus } from "../hooks/useYjsSync";

interface StatusBarProps {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
  saving?: boolean;
}

const RECONNECTED_FLASH_MS = 2_000;

export function StatusBar({
  connected,
  connectionStatus,
  reconnectAttempts,
  disconnectedSince,
  claudeStatus,
  claudeActive,
  readOnly,
  documentCount = 0,
  saving = false,
}: StatusBarProps) {
  const { userName, setUserName } = useUserName();
  const [nameInput, setNameInput] = useState(userName);
  const inputRef = useRef<HTMLInputElement>(null);
  const commitName = () => {
    setUserName(nameInput);
  };
  // Idle-sync: commit c9a63de dropped the always-sync effect because it
  // clobbered in-progress edits. This version syncs only when the input
  // is NOT focused and the value actually differs — so cross-surface
  // changes propagate, but typing is never interrupted.
  useEffect(() => {
    if (nameInput !== userName && document.activeElement !== inputRef.current) {
      setNameInput(userName);
    }
  }, [userName, nameInput]);
  const [showReconnectedFlash, setShowReconnectedFlash] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const prevConnected = useRef(connected);

  useEffect(() => {
    const was = prevConnected.current;
    prevConnected.current = connected;
    if (connected && !was) {
      setShowReconnectedFlash(true);
      const timer = setTimeout(() => setShowReconnectedFlash(false), RECONNECTED_FLASH_MS);
      return () => clearTimeout(timer);
    }
  }, [connected]);

  // Tick elapsed time while disconnected
  useEffect(() => {
    if (disconnectedSince == null) {
      setElapsedSeconds(0);
      return;
    }
    // Set initial value immediately
    setElapsedSeconds(Math.floor((Date.now() - disconnectedSince) / 1000));
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - disconnectedSince) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [disconnectedSince]);

  const isReconnecting = connectionStatus === "connecting";
  const dotColor = connected
    ? "var(--tandem-success)"
    : isReconnecting
      ? "var(--tandem-warning)"
      : "var(--tandem-error)";

  let connLabel: string;
  if (showReconnectedFlash) {
    connLabel = "Reconnected";
  } else if (connectionStatus === "connected") {
    connLabel = "Connected";
  } else if (connectionStatus === "connecting") {
    const parts = ["Reconnecting\u2026"];
    if (reconnectAttempts > 0 || elapsedSeconds > 0) {
      const details: string[] = [];
      if (reconnectAttempts > 0) details.push(`attempt ${reconnectAttempts}`);
      if (elapsedSeconds > 0) details.push(`${elapsedSeconds}s`);
      parts.push(`(${details.join(", ")})`);
    }
    connLabel = parts.join(" ");
  } else {
    connLabel = "Disconnected \u2014 check that the server is running";
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 16px",
        height: "28px",
        borderTop: "1px solid var(--tandem-border)",
        background: "var(--tandem-surface-muted)",
        fontSize: "12px",
        color: "var(--tandem-fg-muted)",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            animation: isReconnecting ? "tandem-reconnect-pulse 1.2s ease-in-out infinite" : "none",
          }}
        />
        <span>{connLabel}</span>
        {documentCount > 0 && (
          <span style={{ color: "var(--tandem-fg-subtle)" }}>
            {documentCount} doc{documentCount !== 1 ? "s" : ""} open
          </span>
        )}
        {saving && (
          <span
            data-testid="save-indicator"
            style={{ color: "var(--tandem-accent)", fontStyle: "italic" }}
          >
            Saving...
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          fontSize: "11px",
          color: "var(--tandem-fg-subtle)",
        }}
      >
        <span>You:</span>
        <input
          ref={inputRef}
          data-testid="user-name-input"
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setNameInput(userName);
              e.currentTarget.blur();
            }
          }}
          aria-label="Display name"
          title="Your display name"
          maxLength={USER_NAME_MAX_LEN}
          style={{
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--tandem-border)",
            color: "var(--tandem-fg-muted)",
            fontSize: "11px",
            width: "80px",
            outline: "none",
            padding: "0 2px",
          }}
        />
      </div>
      {readOnly && (
        <span
          style={{
            padding: "1px 8px",
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--tandem-warning-fg-strong)",
            background: "var(--tandem-warning-bg)",
            borderRadius: "9999px",
            border: "1px solid var(--tandem-warning-border)",
          }}
        >
          Review Only
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "var(--tandem-author-claude)",
            opacity: claudeActive ? 1 : 0.4,
            display: "inline-block",
            transition: "opacity 0.3s ease",
            animation: claudeActive ? "tandem-status-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            transition: "color 0.3s ease",
            color: claudeActive ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)",
          }}
        >
          {claudeStatus ? `Claude -- ${claudeStatus}` : "Claude -- idle"}
        </span>
      </div>
      <style>{`
        @keyframes tandem-status-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
        @keyframes tandem-reconnect-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  );
}
