import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  USER_NAME_MAX_LEN,
} from "../../shared/constants";
import { isTauriRuntime } from "../cowork/cowork-helpers";
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
import { AccessibilitySettings } from "./AccessibilitySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { EditorSettings } from "./EditorSettings";
import { sectionLabelStyle } from "./settingsStyles";

// Lazy-imported so non-Tauri bundles defer loading the Cowork code path and
// so the popover's initial render stays cheap.
const CoworkSettings = lazy(() =>
  import("./CoworkSettings").then((m) => ({ default: m.CoworkSettings })),
);

interface SettingsPopoverProps {
  open: boolean;
  onClose: () => void;
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
  settings,
  onUpdate,
  returnFocusRef,
  anchorRef,
}: SettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  if (!open) return null;

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
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
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
          {"×"}
        </button>
      </div>

      {/* Display Name */}
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

      {/* Appearance: Theme, Layout, Primary Tab/Panel Order, Text Size, Reduce Motion */}
      <AppearanceSettings open={open} settings={settings} onUpdate={onUpdate} />

      {/* Editor Width */}
      <EditorSettings settings={settings} onUpdate={onUpdate} />

      {/* Authorship */}
      <AccessibilitySettings settings={settings} onUpdate={onUpdate} />

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

      {/* Cowork integration — Tauri desktop only (CLI / pure web callers don't
          have the invoke surface PR e ships). */}
      {isTauriRuntime() && (
        <Suspense
          fallback={
            <div
              data-testid="cowork-settings-suspense-fallback"
              style={{ fontSize: 12, color: "var(--tandem-fg-subtle)" }}
            >
              Loading Cowork integration...
            </div>
          }
        >
          <CoworkSettings />
        </Suspense>
      )}
    </div>
  );
}
