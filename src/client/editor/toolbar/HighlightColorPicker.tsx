import React, { useEffect, useRef, useState } from "react";
import { HIGHLIGHT_COLORS } from "../../../shared/constants";
import type { HighlightColor } from "../../../shared/types";
import { ToolbarButton } from "./ToolbarButton";

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "pink", label: "Pink" },
];

interface HighlightColorPickerProps {
  disabled?: boolean;
  onHighlight: (color: HighlightColor) => void;
}

export function HighlightColorPicker({ disabled, onHighlight }: HighlightColorPickerProps) {
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("yellow");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Close color picker when clicking outside
  useEffect(() => {
    if (!showColorPicker) return;

    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showColorPicker]);

  function handleHighlight(e: React.MouseEvent) {
    e.preventDefault();
    onHighlight(highlightColor);
  }

  function handleColorPickerToggle(e: React.MouseEvent) {
    e.preventDefault();
    setShowColorPicker((prev) => !prev);
  }

  function handleColorSelect(color: HighlightColor) {
    setHighlightColor(color);
    setShowColorPicker(false);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px", position: "relative" }}>
      <ToolbarButton
        label="Highlight"
        disabled={disabled}
        disabledTitle="Select text first"
        onMouseDown={handleHighlight}
        style={{ borderRadius: "4px 0 0 4px", borderRight: "none" }}
      />
      <button
        disabled={disabled}
        onMouseDown={handleColorPickerToggle}
        title="Choose highlight color"
        style={{
          padding: "4px 6px",
          fontSize: "13px",
          border: "1px solid var(--tandem-border)",
          borderRadius: "0 4px 4px 0",
          background: disabled ? "var(--tandem-surface-muted)" : "var(--tandem-surface)",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "12px",
            height: "12px",
            borderRadius: "2px",
            background: HIGHLIGHT_COLORS[highlightColor],
            border: "1px solid rgba(0,0,0,0.15)",
          }}
        />
      </button>
      {showColorPicker && (
        <div
          ref={colorPickerRef}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "4px",
            background: "var(--tandem-surface)",
            border: "1px solid var(--tandem-border)",
            borderRadius: "6px",
            padding: "6px",
            display: "flex",
            gap: "4px",
            zIndex: 10,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}
        >
          {HIGHLIGHT_COLOR_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              title={label}
              onClick={() => handleColorSelect(value)}
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "4px",
                border:
                  value === highlightColor
                    ? "2px solid var(--tandem-fg)"
                    : "1px solid rgba(0,0,0,0.15)",
                background: HIGHLIGHT_COLORS[value],
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
          <button
            data-testid="color-picker-close"
            title="Close"
            onClick={() => setShowColorPicker(false)}
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "4px",
              border: "1px solid var(--tandem-border)",
              background: "var(--tandem-surface-muted)",
              cursor: "pointer",
              padding: 0,
              fontSize: "13px",
              color: "var(--tandem-fg-muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
