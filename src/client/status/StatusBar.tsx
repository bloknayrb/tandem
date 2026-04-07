import React, { useEffect, useRef, useState } from "react";
import { CLAUDE_PRESENCE_COLOR, USER_NAME_KEY, USER_NAME_DEFAULT } from "../../shared/constants";
import type { TandemMode } from "../../shared/types";
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
  tandemMode: TandemMode;
  onModeChange: (mode: TandemMode) => void;
  heldCount: number;
  onSettingsClick?: (rect: DOMRect) => void;
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
  tandemMode,
  onModeChange,
  heldCount,
  onSettingsClick,
}: StatusBarProps) {
  const [userName, setUserName] = useState(() => {
    try {
      return localStorage.getItem(USER_NAME_KEY)?.trim() || USER_NAME_DEFAULT;
    } catch {
      return USER_NAME_DEFAULT;
    }
  });
  const [nameInput, setNameInput] = useState(userName);
  const commitName = () => {
    const trimmed = nameInput.trim() || USER_NAME_DEFAULT;
    setUserName(trimmed);
    setNameInput(trimmed);
    try {
      localStorage.setItem(USER_NAME_KEY, trimmed);
    } catch {
      // localStorage unavailable (incognito/storage-disabled)
    }
  };
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
  const dotColor = connected ? "#22c55e" : isReconnecting ? "#eab308" : "#ef4444";

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
        borderTop: "1px solid #e5e7eb",
        background: "#fafafa",
        fontSize: "12px",
        color: "#6b7280",
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
          <span style={{ color: "#9ca3af" }}>
            {documentCount} doc{documentCount !== 1 ? "s" : ""} open
          </span>
        )}
      </div>

      {/* Mode switcher */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {heldCount > 0 && (
          <span
            style={{
              padding: "1px 6px",
              fontSize: "10px",
              fontWeight: 600,
              color: "#92400e",
              background: "#fef3c7",
              borderRadius: "9999px",
            }}
          >
            {heldCount} held
          </span>
        )}
        <div
          style={{
            display: "flex",
            border: "1px solid #d1d5db",
            borderRadius: "4px",
            overflow: "hidden",
          }}
        >
          <button
            title="Write undisturbed — Claude only responds when you message"
            onClick={() => onModeChange("solo")}
            style={{
              padding: "1px 8px",
              fontSize: "11px",
              border: "none",
              borderRight: "1px solid #d1d5db",
              cursor: "pointer",
              background: tandemMode === "solo" ? "#6366f1" : "transparent",
              color: tandemMode === "solo" ? "#fff" : "#6b7280",
              fontWeight: tandemMode === "solo" ? 600 : 400,
            }}
          >
            Solo
          </button>
          <button
            title="Full collaboration — Claude reacts to selections and document changes"
            onClick={() => onModeChange("tandem")}
            style={{
              padding: "1px 8px",
              fontSize: "11px",
              border: "none",
              cursor: "pointer",
              background: tandemMode === "tandem" ? "#6366f1" : "transparent",
              color: tandemMode === "tandem" ? "#fff" : "#6b7280",
              fontWeight: tandemMode === "tandem" ? 600 : 400,
            }}
          >
            Tandem
          </button>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }}>
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: tandemMode === "tandem" ? "#22c55e" : "#9ca3af",
              display: "inline-block",
            }}
          />
          <span style={{ color: "#9ca3af" }}>
            {tandemMode === "tandem" ? "Claude is active" : "Claude is listening"}
          </span>
        </span>
        <button
          title="Layout settings"
          aria-label="Layout settings"
          onClick={(e) => onSettingsClick?.(e.currentTarget.getBoundingClientRect())}
          style={{
            padding: "1px 8px",
            fontSize: "11px",
            border: "1px solid #d1d5db",
            borderRadius: "4px",
            cursor: "pointer",
            background: "transparent",
            color: "#6b7280",
            fontWeight: 400,
          }}
        >
          Settings
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          fontSize: "11px",
          color: "#9ca3af",
        }}
      >
        <span>You:</span>
        <input
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
          title="Your display name (updates on next tab switch or refresh)"
          maxLength={40}
          style={{
            background: "transparent",
            border: "none",
            borderBottom: "1px solid #e5e7eb",
            color: "#6b7280",
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
            color: "#92400e",
            background: "#fef3c7",
            borderRadius: "9999px",
            border: "1px solid #fde68a",
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
            background: CLAUDE_PRESENCE_COLOR,
            opacity: claudeActive ? 1 : 0.4,
            display: "inline-block",
            transition: "opacity 0.3s ease",
            animation: claudeActive ? "tandem-status-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{ transition: "color 0.3s ease", color: claudeActive ? "#4b5563" : "#9ca3af" }}
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
