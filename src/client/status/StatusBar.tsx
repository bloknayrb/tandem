import React, { useEffect, useRef, useState } from "react";
import { CLAUDE_PRESENCE_COLOR, USER_NAME_KEY, USER_NAME_DEFAULT } from "../../shared/constants";
import type { InterruptionMode } from "../../shared/types";

interface StatusBarProps {
  connected: boolean;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
  interruptionMode: InterruptionMode;
  onModeChange: (mode: InterruptionMode) => void;
  heldCount: number;
}

const MODES: { value: InterruptionMode; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Show all annotations immediately" },
  {
    value: "urgent-only",
    label: "Urgent",
    title: "Show flags, questions, and explicitly urgent annotations",
  },
  { value: "paused", label: "Paused", title: "Hold all new annotations" },
];

const RECONNECTED_FLASH_MS = 2_000;
const SERVER_CHECK_MS = 30_000;

export function StatusBar({
  connected,
  claudeStatus,
  claudeActive,
  readOnly,
  documentCount = 0,
  interruptionMode,
  onModeChange,
  heldCount,
}: StatusBarProps) {
  const [userName, setUserName] = useState(
    () => localStorage.getItem(USER_NAME_KEY)?.trim() || USER_NAME_DEFAULT,
  );
  const [nameInput, setNameInput] = useState(userName);
  const commitName = () => {
    const trimmed = nameInput.trim() || USER_NAME_DEFAULT;
    setUserName(trimmed);
    setNameInput(trimmed);
    localStorage.setItem(USER_NAME_KEY, trimmed);
  };
  const [showReconnectedFlash, setShowReconnectedFlash] = useState(false);
  const [showServerBanner, setShowServerBanner] = useState(false);
  const prevConnected = useRef(connected);
  const disconnectedAt = useRef<number | null>(null);

  useEffect(() => {
    const was = prevConnected.current;
    prevConnected.current = connected;
    if (!connected) {
      if (disconnectedAt.current === null) disconnectedAt.current = Date.now();
      const timer = setTimeout(() => setShowServerBanner(true), SERVER_CHECK_MS);
      return () => clearTimeout(timer);
    }
    disconnectedAt.current = null;
    setShowServerBanner(false);
    if (!was) {
      setShowReconnectedFlash(true);
      const timer = setTimeout(() => setShowReconnectedFlash(false), RECONNECTED_FLASH_MS);
      return () => clearTimeout(timer);
    }
  }, [connected]);

  const isReconnecting = !connected && disconnectedAt.current !== null;
  const dotColor = connected ? "#22c55e" : isReconnecting ? "#eab308" : "#ef4444";
  const connLabel = showReconnectedFlash
    ? "Reconnected"
    : connected
      ? "Connected"
      : isReconnecting
        ? "Reconnecting\u2026"
        : "Disconnected";

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
        {showServerBanner && !connected && (
          <span style={{ color: "#eab308", fontWeight: 500 }}>— check server</span>
        )}
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
          {MODES.map(({ value, label, title }) => (
            <button
              key={value}
              title={title}
              onClick={() => onModeChange(value)}
              style={{
                padding: "1px 8px",
                fontSize: "11px",
                border: "none",
                cursor: "pointer",
                background: interruptionMode === value ? "#6366f1" : "transparent",
                color: interruptionMode === value ? "#fff" : "#6b7280",
                fontWeight: interruptionMode === value ? 600 : 400,
                borderRight: value !== "paused" ? "1px solid #d1d5db" : "none",
              }}
            >
              {label}
            </button>
          ))}
        </div>
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
