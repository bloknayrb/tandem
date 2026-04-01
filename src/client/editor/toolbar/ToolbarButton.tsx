import React from "react";

export function ToolbarButton({
  label,
  shortcut,
  disabled,
  active,
  onMouseDown,
  onClick,
  style,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  active?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  let border = "1px solid #e5e7eb";
  let background = "#fff";
  let color = "#374151";

  if (disabled) {
    background = "#f9fafb";
    color = "#9ca3af";
  } else if (active) {
    border = "1px solid #818cf8";
    background = "#eef2ff";
    color = "#4338ca";
  }

  return (
    <button
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: "13px",
        border,
        borderRadius: "4px",
        background,
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {label}
    </button>
  );
}
