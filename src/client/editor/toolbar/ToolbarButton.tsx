import React from "react";

type ToolbarButtonProps = (
  | { label: string; ariaLabel?: string }
  | { label: React.ReactNode; ariaLabel: string }
) & {
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
  active?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  style?: React.CSSProperties;
};

export function ToolbarButton({
  label,
  ariaLabel,
  shortcut,
  disabled,
  disabledTitle,
  active,
  onMouseDown,
  onClick,
  style,
}: ToolbarButtonProps) {
  let border = "1px solid var(--tandem-border)";
  let background = "var(--tandem-surface)";
  let color = "var(--tandem-fg)";

  if (disabled) {
    background = "var(--tandem-surface-muted)";
    color = "var(--tandem-fg-subtle)";
  } else if (active) {
    border = "1px solid var(--tandem-accent)";
    background = "var(--tandem-accent-bg)";
    color = "var(--tandem-accent-fg-strong)";
  }

  const ariaLabelValue = ariaLabel ?? (typeof label === "string" ? label : undefined);
  const titleText = ariaLabelValue ?? "";

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled && disabledTitle
          ? disabledTitle
          : shortcut
            ? `${titleText} (${shortcut})`
            : titleText
      }
      aria-label={ariaLabelValue}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: "13px",
        borderRadius: "4px",
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
        border,
        background,
        color,
      }}
    >
      {label}
    </button>
  );
}
