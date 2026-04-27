import type { TandemSettings } from "../hooks/useTandemSettings";
import { sectionLabelStyle } from "./settingsStyles";

interface EditorSettingsProps {
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

export function EditorSettings({ settings, onUpdate }: EditorSettingsProps) {
  return (
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
        min={40}
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
        <span>40%</span>
        <span>100%</span>
      </div>
    </div>
  );
}
