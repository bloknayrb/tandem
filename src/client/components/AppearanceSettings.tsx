import React, { useEffect, useState } from "react";
import { useRadioGroup } from "../hooks/useRadioGroup";
import type {
  LayoutMode,
  PanelOrder,
  PrimaryTab,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "../hooks/useTandemSettings";
import { sectionLabelStyle } from "./settingsStyles";

interface AppearanceSettingsProps {
  open: boolean;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

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

export function AppearanceSettings({ open, settings, onUpdate }: AppearanceSettingsProps) {
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const threePanelDisabled = viewportWidth < 768;

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

  return (
    <>
      {/* Theme */}
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

      {/* Text Size */}
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

      {/* Reduce Motion */}
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
    </>
  );
}
