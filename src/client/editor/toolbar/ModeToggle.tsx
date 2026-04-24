import type { TandemMode } from "../../../shared/types";

interface ModeToggleProps {
  tandemMode: TandemMode;
  onModeChange: (mode: TandemMode) => void;
}

export function ModeToggle({ tandemMode, onModeChange }: ModeToggleProps) {
  return (
    <div
      data-testid="mode-toggle"
      role="group"
      aria-label="Claude collaboration mode"
      style={{
        display: "flex",
        border: "1px solid var(--tandem-border-strong)",
        borderRadius: "4px",
        overflow: "hidden",
      }}
    >
      <button
        data-testid="mode-solo-btn"
        title="Write undisturbed — Claude only responds when you message"
        aria-pressed={tandemMode === "solo"}
        onClick={() => onModeChange("solo")}
        style={{
          padding: "3px 10px",
          fontSize: "12px",
          border: "none",
          cursor: "pointer",
          background: tandemMode === "solo" ? "var(--tandem-accent)" : "transparent",
          color: tandemMode === "solo" ? "var(--tandem-accent-fg)" : "var(--tandem-fg-muted)",
          fontWeight: tandemMode === "solo" ? 600 : 400,
          borderRight: "1px solid var(--tandem-border-strong)",
          display: "flex",
          alignItems: "center",
          gap: "5px",
        }}
      >
        {tandemMode === "solo" && (
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--tandem-fg-subtle)",
              display: "inline-block",
            }}
          />
        )}
        Solo
      </button>
      <button
        data-testid="mode-tandem-btn"
        title="Full collaboration — Claude reacts to selections and document changes"
        aria-pressed={tandemMode === "tandem"}
        onClick={() => onModeChange("tandem")}
        style={{
          padding: "3px 10px",
          fontSize: "12px",
          border: "none",
          cursor: "pointer",
          background: tandemMode === "tandem" ? "var(--tandem-accent)" : "transparent",
          color: tandemMode === "tandem" ? "var(--tandem-accent-fg)" : "var(--tandem-fg-muted)",
          fontWeight: tandemMode === "tandem" ? 600 : 400,
          display: "flex",
          alignItems: "center",
          gap: "5px",
        }}
      >
        {tandemMode === "tandem" && (
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--tandem-success)",
              display: "inline-block",
            }}
          />
        )}
        Tandem
      </button>
    </div>
  );
}
