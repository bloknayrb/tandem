import React from "react";

export function ToolbarButton({
  label,
  shortcut,
  disabled,
  onMouseDown,
  onClick,
  style,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: "13px",
        border: "1px solid #e5e7eb",
        borderRadius: "4px",
        background: disabled ? "#f9fafb" : "#fff",
        color: disabled ? "#9ca3af" : "#374151",
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {label}
    </button>
  );
}
