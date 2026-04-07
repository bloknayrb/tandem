import React, { useEffect, useRef, useState } from "react";
import type { TandemSettings } from "../hooks/useTandemSettings";

interface SettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

const POPOVER_WIDTH = 320;

export function SettingsPopover({
  open,
  onClose,
  anchorRect,
  settings,
  onUpdate,
}: SettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);

  // Track viewport width for three-panel availability (only while open)
  useEffect(() => {
    if (!open) return;
    setViewportWidth(window.innerWidth);
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [open]);

  // Dismiss on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener attachment so the opening click doesn't immediately close
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [open, onClose]);

  // Dismiss on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const threePanelDisabled = viewportWidth < 768;

  // Position below the anchor, centered horizontally
  const left = Math.max(
    8,
    Math.min(
      anchorRect.left + anchorRect.width / 2 - POPOVER_WIDTH / 2,
      window.innerWidth - POPOVER_WIDTH - 8,
    ),
  );
  const top = anchorRect.bottom + 6;

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: "11px",
    fontWeight: 600,
    color: "#374151",
    marginBottom: "6px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  };

  const cardStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px",
    border: selected ? "2px solid #6366f1" : "2px solid #e5e7eb",
    borderRadius: "6px",
    background: disabled ? "#f3f4f6" : selected ? "#eef2ff" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    textAlign: "center",
    fontSize: "11px",
    color: disabled ? "#9ca3af" : selected ? "#4338ca" : "#6b7280",
    fontWeight: selected ? 600 : 400,
    opacity: disabled ? 0.6 : 1,
    transition: "border-color 0.15s, background 0.15s",
  });

  return (
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${POPOVER_WIDTH}px`,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
        padding: "16px",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "13px", fontWeight: 600, color: "#111827" }}>Layout Settings</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#9ca3af",
            fontSize: "16px",
            lineHeight: 1,
            padding: "0 2px",
          }}
          aria-label="Close settings"
        >
          {"\u00d7"}
        </button>
      </div>

      {/* Layout mode */}
      <div>
        <div style={sectionLabelStyle}>Layout</div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => onUpdate({ layout: "tabbed" })}
            style={cardStyle(settings.layout === "tabbed")}
            aria-pressed={settings.layout === "tabbed"}
          >
            <div style={{ fontSize: "18px", marginBottom: "2px" }}>{"[=|]"}</div>
            Tabbed
          </button>
          <button
            onClick={() => {
              if (!threePanelDisabled) onUpdate({ layout: "three-panel" });
            }}
            style={cardStyle(settings.layout === "three-panel", threePanelDisabled)}
            aria-pressed={settings.layout === "three-panel"}
            title={threePanelDisabled ? "Requires viewport wider than 768px" : undefined}
          >
            <div style={{ fontSize: "18px", marginBottom: "2px" }}>{"[|||]"}</div>
            Three-Panel
          </button>
        </div>
        {threePanelDisabled && (
          <div style={{ fontSize: "10px", color: "#9ca3af", marginTop: "4px" }}>
            Three-panel requires a wider viewport
          </div>
        )}
      </div>

      {/* Primary tab (tabbed mode only) */}
      {settings.layout === "tabbed" && (
        <div>
          <div style={sectionLabelStyle}>Default Tab</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => onUpdate({ primaryTab: "chat" })}
              style={cardStyle(settings.primaryTab === "chat")}
              aria-pressed={settings.primaryTab === "chat"}
            >
              Chat
            </button>
            <button
              onClick={() => onUpdate({ primaryTab: "annotations" })}
              style={cardStyle(settings.primaryTab === "annotations")}
              aria-pressed={settings.primaryTab === "annotations"}
            >
              Annotations
            </button>
          </div>
        </div>
      )}

      {/* Panel order (three-panel mode only) */}
      {settings.layout === "three-panel" && (
        <div>
          <div style={sectionLabelStyle}>Panel Order</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => onUpdate({ panelOrder: "chat-editor-annotations" })}
              style={cardStyle(settings.panelOrder === "chat-editor-annotations")}
              aria-pressed={settings.panelOrder === "chat-editor-annotations"}
            >
              Chat | Editor | Ann.
            </button>
            <button
              onClick={() => onUpdate({ panelOrder: "annotations-editor-chat" })}
              style={cardStyle(settings.panelOrder === "annotations-editor-chat")}
              aria-pressed={settings.panelOrder === "annotations-editor-chat"}
            >
              Ann. | Editor | Chat
            </button>
          </div>
        </div>
      )}

      {/* Editor width */}
      <div>
        <div style={sectionLabelStyle}>
          Editor Width:{" "}
          <span style={{ fontWeight: 400, textTransform: "none" }}>
            {settings.editorWidthPercent}%
          </span>
        </div>
        <div style={{ fontSize: "10px", color: "#9ca3af", marginBottom: "6px" }}>
          How much of the available space the editor text fills
        </div>
        <input
          type="range"
          min={50}
          max={100}
          step={5}
          value={settings.editorWidthPercent}
          onChange={(e) => onUpdate({ editorWidthPercent: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "#6366f1" }}
          aria-label="Editor width"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "10px",
            color: "#9ca3af",
          }}
        >
          <span>50%</span>
          <span>100%</span>
        </div>
      </div>
    </div>
  );
}
