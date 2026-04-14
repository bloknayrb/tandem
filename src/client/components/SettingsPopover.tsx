import React, { useEffect, useRef, useState } from "react";
import {
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  USER_NAME_MAX_LEN,
} from "../../shared/constants";
import { useRadioGroup } from "../hooks/useRadioGroup";
import type {
  LayoutMode,
  PanelOrder,
  PrimaryTab,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "../hooks/useTandemSettings";
import { useUserName } from "../hooks/useUserName";

interface SettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  /** Element to return focus to on close (typically the settings gear button). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Element that toggles the popover. Excluded from outside-click detection
   * so the anchor's own click handler (not the dismiss logic) controls
   * close-while-open.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
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
  anchorRef,
}: SettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const threePanelDisabled = viewportWidth < 768;
  const { userName, setUserName } = useUserName();
  const [nameInput, setNameInput] = useState(userName);

  // Idle-sync: commit c9a63de dropped the always-sync effect because it
  // clobbered in-progress edits. This version syncs only when the input
  // is NOT focused and the value actually differs — so cross-surface
  // changes propagate, but typing is never interrupted.
  useEffect(() => {
    if (nameInput !== userName && document.activeElement !== inputRef.current) {
      setNameInput(userName);
    }
  }, [userName, nameInput]);

  const themeRg = useRadioGroup<ThemePreference>(
    settings.theme,
    ["light", "dark", "system"] as const,
    (t) => onUpdate({ theme: t }),
  );
  const layoutRg = useRadioGroup<LayoutMode>(
    settings.layout,
    ["tabbed", "three-panel"] as const,
    (l) => onUpdate({ layout: l }),
    (l) => l === "three-panel" && threePanelDisabled,
  );
  const primaryTabRg = useRadioGroup<PrimaryTab>(
    settings.primaryTab,
    ["chat", "annotations"] as const,
    (p) => onUpdate({ primaryTab: p }),
  );
  const panelOrderRg = useRadioGroup<PanelOrder>(
    settings.panelOrder,
    ["chat-editor-annotations", "annotations-editor-chat"] as const,
    (p) => onUpdate({ panelOrder: p }),
  );
  const textSizeRg = useRadioGroup<TextSize>(settings.textSize, ["s", "m", "l"] as const, (t) =>
    onUpdate({ textSize: t }),
  );

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
      const target = e.target as Node;
      // Let the anchor's own click handler toggle the popover — otherwise the
      // pointerdown-outside close races with the click-reopen and the popover
      // re-opens immediately.
      if (anchorRef?.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("pointerdown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handler);
    };
  }, [open, onClose, anchorRef]);

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
    color: "var(--tandem-fg)",
    marginBottom: "6px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  };

  const cardStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px",
    minHeight: "24px",
    border: `2px solid ${selected ? "var(--tandem-accent)" : "var(--tandem-border)"}`,
    borderRadius: "6px",
    background: disabled
      ? "var(--tandem-surface-muted)"
      : selected
        ? "var(--tandem-accent-bg)"
        : "var(--tandem-surface)",
    cursor: disabled ? "not-allowed" : "pointer",
    textAlign: "center",
    fontSize: "11px",
    color: disabled
      ? "var(--tandem-fg-subtle)"
      : selected
        ? "var(--tandem-accent-fg-strong)"
        : "var(--tandem-fg-muted)",
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
        background: "var(--tandem-surface)",
        color: "var(--tandem-fg)",
        border: "1px solid var(--tandem-border)",
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
        <span
          id={HEADING_ID}
          style={{ fontSize: "13px", fontWeight: 600, color: "var(--tandem-fg)" }}
        >
          Settings
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--tandem-fg-subtle)",
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

      <div>
        <label htmlFor="settings-display-name" style={sectionLabelStyle}>
          Display Name
        </label>
        <input
          ref={inputRef}
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
          maxLength={USER_NAME_MAX_LEN}
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "12px",
            color: "var(--tandem-fg)",
            background: "var(--tandem-surface)",
            border: "1px solid var(--tandem-border-strong)",
            borderRadius: "4px",
            outline: "none",
          }}
        />
      </div>

      <div>
        <div id="settings-theme-label" style={sectionLabelStyle}>
          Theme
        </div>
        <div
          role="radiogroup"
          aria-labelledby="settings-theme-label"
          onKeyDown={themeRg.handleKeyDown}
          style={{ display: "flex", gap: "8px" }}
        >
          {(["light", "dark", "system"] as const).map((t) => (
            <button
              key={t}
              data-testid={`theme-${t}-btn`}
              role="radio"
              aria-checked={settings.theme === t}
              tabIndex={themeRg.tabIndexFor(t)}
              onClick={() => onUpdate({ theme: t })}
              style={cardStyle(settings.theme === t)}
            >
              {t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}
            </button>
          ))}
        </div>
      </div>

      {/* Layout mode */}
      <div>
        <div id="settings-layout-label" style={sectionLabelStyle}>
          Layout
        </div>
        <div
          role="radiogroup"
          aria-labelledby="settings-layout-label"
          onKeyDown={layoutRg.handleKeyDown}
          style={{ display: "flex", gap: "8px" }}
        >
          <button
            data-testid="layout-tabbed-btn"
            role="radio"
            aria-checked={settings.layout === "tabbed"}
            tabIndex={layoutRg.tabIndexFor("tabbed")}
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
            tabIndex={layoutRg.tabIndexFor("three-panel")}
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
          <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginTop: "4px" }}>
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
            onKeyDown={primaryTabRg.handleKeyDown}
            style={{ display: "flex", gap: "8px" }}
          >
            <button
              data-testid="default-tab-chat-btn"
              role="radio"
              aria-checked={settings.primaryTab === "chat"}
              tabIndex={primaryTabRg.tabIndexFor("chat")}
              onClick={() => onUpdate({ primaryTab: "chat" })}
              style={cardStyle(settings.primaryTab === "chat")}
            >
              Chat
            </button>
            <button
              data-testid="default-tab-annotations-btn"
              role="radio"
              aria-checked={settings.primaryTab === "annotations"}
              tabIndex={primaryTabRg.tabIndexFor("annotations")}
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
            onKeyDown={panelOrderRg.handleKeyDown}
            style={{ display: "flex", gap: "8px" }}
          >
            <button
              data-testid="panel-order-cea-btn"
              role="radio"
              aria-checked={settings.panelOrder === "chat-editor-annotations"}
              tabIndex={panelOrderRg.tabIndexFor("chat-editor-annotations")}
              onClick={() => onUpdate({ panelOrder: "chat-editor-annotations" })}
              style={cardStyle(settings.panelOrder === "chat-editor-annotations")}
            >
              Chat | Editor | Ann.
            </button>
            <button
              data-testid="panel-order-aec-btn"
              role="radio"
              aria-checked={settings.panelOrder === "annotations-editor-chat"}
              tabIndex={panelOrderRg.tabIndexFor("annotations-editor-chat")}
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
        <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginBottom: "6px" }}>
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
          style={{ width: "100%", accentColor: "var(--tandem-accent)" }}
          aria-label="Editor width"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "10px",
            color: "var(--tandem-fg-subtle)",
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
            color: "var(--tandem-fg)",
            minHeight: "24px",
          }}
        >
          <input
            type="checkbox"
            checked={settings.showAuthorship}
            onChange={(e) => onUpdate({ showAuthorship: e.target.checked })}
            style={{ accentColor: "var(--tandem-accent)" }}
          />
          <span>Show who wrote what</span>
        </label>
        <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginTop: "4px" }}>
          Highlights text by author: <span style={{ color: "var(--tandem-author-user)" }}>you</span>{" "}
          / <span style={{ color: "var(--tandem-author-claude)" }}>Claude</span>
        </div>
      </div>

      <div>
        <div id="settings-text-size-label" style={sectionLabelStyle}>
          Text Size
        </div>
        <div
          role="radiogroup"
          aria-labelledby="settings-text-size-label"
          onKeyDown={textSizeRg.handleKeyDown}
          style={{ display: "flex", gap: "8px" }}
        >
          {(["s", "m", "l"] as const).map((size) => (
            <button
              key={size}
              data-testid={`text-size-${size}-btn`}
              role="radio"
              aria-checked={settings.textSize === size}
              tabIndex={textSizeRg.tabIndexFor(size)}
              onClick={() => onUpdate({ textSize: size })}
              style={cardStyle(settings.textSize === size)}
            >
              {size === "s" ? "Small" : size === "m" ? "Medium" : "Large"}
            </button>
          ))}
        </div>
        <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginTop: "4px" }}>
          Reading density only — use browser zoom (Ctrl + =/−) to scale the whole UI.
        </div>
      </div>

      <div>
        <label
          data-testid="reduce-motion-toggle"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
            fontSize: "12px",
            color: "var(--tandem-fg)",
            minHeight: "24px",
          }}
        >
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => onUpdate({ reduceMotion: e.target.checked })}
            style={{ accentColor: "var(--tandem-accent)" }}
          />
          <span>Reduce motion</span>
        </label>
        <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginTop: "4px" }}>
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
        <div style={{ fontSize: "10px", color: "var(--tandem-fg-subtle)", marginBottom: "6px" }}>
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
          style={{ width: "100%", accentColor: "var(--tandem-accent)" }}
          aria-label="Selection dwell time"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "10px",
            color: "var(--tandem-fg-subtle)",
          }}
        >
          <span>{(SELECTION_DWELL_MIN_MS / 1000).toFixed(1)}s</span>
          <span>{(SELECTION_DWELL_MAX_MS / 1000).toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
}
