import type { TandemSettings } from "../hooks/useTandemSettings";
import { sectionLabelStyle } from "./settingsStyles";

interface AccessibilitySettingsProps {
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

export function AccessibilitySettings({ settings, onUpdate }: AccessibilitySettingsProps) {
  return (
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
        Highlights text by author: <span style={{ color: "var(--tandem-author-user)" }}>you</span> /{" "}
        <span style={{ color: "var(--tandem-author-claude)" }}>Claude</span>
      </div>
    </div>
  );
}
