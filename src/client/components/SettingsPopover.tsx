import React, { useEffect, useRef, useState } from "react";
import { SELECTION_DWELL_MAX_MS, SELECTION_DWELL_MIN_MS } from "../../shared/constants";
import type { TandemSettings } from "../hooks/useTandemSettings";
import { useUserName } from "../hooks/useUserName";

interface SettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  /** Element to return focus to on close (typically the settings gear button). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const POPOVER_WIDTH = 320;
const HEADING_ID = "tandem-settings-heading";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsPopover({
  open,
  onClose,
  anchorRect,
  settings,
  onUpdate,
  returnFocusRef,
}: SettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const { userName, setUserName } = useUserName();
  const [nameInput, setNameInput] = useState(userName);

  // Track viewport width for three-panel availability (only while open)
  useEffect(() => {
    if (!open) return;
    setViewportWidth(window.innerWidth);
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [open]);

  // Initial focus + focus return on close
  useEffect(() => {
    if (!open) return;
    // Focus the dialog container so screen readers announce the heading;
    // Tab then moves into the content.
    const node = popoverRef.current;
    node?.focus();
    return () => {
      returnFocusRef?.current?.focus();
    };
  }, [open, returnFocusRef]);

  // Outside-dismiss on pointerdown (covers mouse + touch + pen)
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("pointerdown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handler);
    };
  }, [open, onClose]);

  // Escape to close + focus trap on Tab
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !popoverRef.current) return;
      const focusables = popoverRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // If focus has escaped the dialog entirely, pull it back in.
      if (!popoverRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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
    minHeight: "24px",
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
      data-testid="settings-popover"
      role="dialog"
      aria-modal="true"
      aria-labelledby={HEADING_ID}
      tabIndex={-1}
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
        outline: "none",
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
        <span id={HEADING_ID} style={{ fontSize: "13px", fontWeight: 600, color: "#111827" }}>
          Settings
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#9ca3af",
            fontSize: "16px",
            lineHeight: 1,
            padding: "4px 6px",
            minWidth: "24px",
            minHeight: "24px",
          }}
          aria-label="Close settings"
        >
          {"\u00d7"}
        </button>
      </div>

      {/* Display name */}
      <div>
        <label htmlFor="settings-display-name" style={sectionLabelStyle}>
          Display Name
        </label>
        <input
          id="settings-display-name"
          data-testid="settings-display-name"
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={() => setUserName(nameInput)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setNameInput(userName);
              e.currentTarget.blur();
            }
          }}
          maxLength={40}
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "12px",
            color: "#111827",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: "4px",
            outline: "none",
          }}
        />
      </div>

      {/* Layout mode */}
      <div>
        <div id="settings-layout-label" style={sectionLabelStyle}>
          Layout
        </div>
        <div
          role="radiogroup"
          aria-labelledby="settings-layout-label"
          style={{ display: "flex", gap: "8px" }}
        >
          <button
            data-testid="layout-tabbed-btn"
            role="radio"
            aria-checked={settings.layout === "tabbed"}
            onClick={() => onUpdate({ layout: "tabbed" })}
            style={cardStyle(settings.layout === "tabbed")}
          >
            <div style={{ fontSize: "18px", marginBottom: "2px" }}>{"[=|]"}</div>
            Tabbed
          </button>
          <button
            data-testid="layout-three-panel-btn"
            role="radio"
            aria-checked={settings.layout === "three-panel"}
            aria-disabled={threePanelDisabled || undefined}
            onClick={() => {
              if (!threePanelDisabled) onUpdate({ layout: "three-panel" });
            }}
            style={cardStyle(settings.layout === "three-panel", threePanelDisabled)}
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
          <div id="settings-default-tab-label" style={sectionLabelStyle}>
            Default Tab
          </div>
          <div
            role="radiogroup"
            aria-labelledby="settings-default-tab-label"
            style={{ display: "flex", gap: "8px" }}
          >
            <button
              data-testid="default-tab-chat-btn"
              role="radio"
              aria-checked={settings.primaryTab === "chat"}
              onClick={() => onUpdate({ primaryTab: "chat" })}
              style={cardStyle(settings.primaryTab === "chat")}
            >
              Chat
            </button>
            <button
              data-testid="default-tab-annotations-btn"
              role="radio"
              aria-checked={settings.primaryTab === "annotations"}
              onClick={() => onUpdate({ primaryTab: "annotations" })}
              style={cardStyle(settings.primaryTab === "annotations")}
            >
              Annotations
            </button>
          </div>
        </div>
      )}

      {/* Panel order (three-panel mode only) */}
      {settings.layout === "three-panel" && (
        <div>
          <div id="settings-panel-order-label" style={sectionLabelStyle}>
            Panel Order
          </div>
          <div
            role="radiogroup"
            aria-labelledby="settings-panel-order-label"
            style={{ display: "flex", gap: "8px" }}
          >
            <button
              data-testid="panel-order-cea-btn"
              role="radio"
              aria-checked={settings.panelOrder === "chat-editor-annotations"}
              onClick={() => onUpdate({ panelOrder: "chat-editor-annotations" })}
              style={cardStyle(settings.panelOrder === "chat-editor-annotations")}
            >
              Chat | Editor | Ann.
            </button>
            <button
              data-testid="panel-order-aec-btn"
              role="radio"
              aria-checked={settings.panelOrder === "annotations-editor-chat"}
              onClick={() => onUpdate({ panelOrder: "annotations-editor-chat" })}
              style={cardStyle(settings.panelOrder === "annotations-editor-chat")}
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
          data-testid="editor-width-slider"
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

      {/* Authorship tracking toggle */}
      <div>
        <div style={sectionLabelStyle}>Authorship</div>
        <label
          data-testid="authorship-toggle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
            fontSize: "12px",
            color: "#374151",
            minHeight: "24px",
          }}
        >
          <input
            type="checkbox"
            checked={settings.showAuthorship}
            onChange={(e) => onUpdate({ showAuthorship: e.target.checked })}
            style={{ accentColor: "#6366f1" }}
          />
          <span>Show who wrote what</span>
        </label>
        <div style={{ fontSize: "10px", color: "#9ca3af", marginTop: "4px" }}>
          Highlights text by author: <span style={{ color: "#3b82f6" }}>you</span> /{" "}
          <span style={{ color: "#ea8a1e" }}>Claude</span>
        </div>
      </div>

      {/* Reduce motion */}
      <div>
        <label
          data-testid="reduce-motion-toggle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
            fontSize: "12px",
            color: "#374151",
            minHeight: "24px",
          }}
        >
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => onUpdate({ reduceMotion: e.target.checked })}
            style={{ accentColor: "#6366f1" }}
          />
          <span>Reduce motion</span>
        </label>
        <div style={{ fontSize: "10px", color: "#9ca3af", marginTop: "4px" }}>
          Disables smooth autoscroll and the annotation flash animation.
        </div>
      </div>

      {/* Selection sensitivity (dwell time) */}
      <div>
        <div style={sectionLabelStyle}>
          Selection Sensitivity:{" "}
          <span style={{ fontWeight: 400, textTransform: "none" }}>
            {(settings.selectionDwellMs / 1000).toFixed(1)}s
          </span>
        </div>
        <div style={{ fontSize: "10px", color: "#9ca3af", marginBottom: "6px" }}>
          How long you must hold a selection before Claude notices it
        </div>
        <input
          data-testid="dwell-time-slider"
          type="range"
          min={SELECTION_DWELL_MIN_MS}
          max={SELECTION_DWELL_MAX_MS}
          step={100}
          value={settings.selectionDwellMs}
          onChange={(e) => onUpdate({ selectionDwellMs: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "#6366f1" }}
          aria-label="Selection dwell time"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "10px",
            color: "#9ca3af",
          }}
        >
          <span>{(SELECTION_DWELL_MIN_MS / 1000).toFixed(1)}s</span>
          <span>{(SELECTION_DWELL_MAX_MS / 1000).toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
}
