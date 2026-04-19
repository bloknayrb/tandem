import { useEffect } from "react";

interface ShortcutRow {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "Editor",
    rows: [
      { keys: ["Ctrl", "B"], description: "Bold" },
      { keys: ["Ctrl", "I"], description: "Italic" },
      { keys: ["Ctrl", "Z"], description: "Undo" },
      { keys: ["Ctrl", "Y"], description: "Redo" },
      { keys: ["Ctrl", "S"], description: "Save document" },
    ],
  },
  {
    title: "Review Mode",
    rows: [
      { keys: ["Tab"], description: "Next annotation" },
      { keys: ["Shift", "Tab"], description: "Previous annotation" },
      { keys: ["Y"], description: "Accept annotation" },
      { keys: ["N"], description: "Reject annotation" },
      { keys: ["Z"], description: "Undo last accept/reject" },
      { keys: ["E"], description: "Examine (scroll & exit)" },
      { keys: ["Escape"], description: "Exit review mode" },
    ],
  },
  {
    title: "Chat",
    rows: [{ keys: ["Enter"], description: "Send message" }],
  },
  {
    title: "Tabs",
    rows: [
      { keys: ["Ctrl", "Tab"], description: "Next tab" },
      { keys: ["Ctrl", "Shift", "Tab"], description: "Previous tab" },
      { keys: ["Alt", "←"], description: "Move tab left" },
      { keys: ["Alt", "→"], description: "Move tab right" },
    ],
  },
  {
    title: "General",
    rows: [{ keys: ["?"], description: "Show / hide this help" }],
  },
];

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

export function HelpModal({ open, onClose }: HelpModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
      data-testid="help-modal"
    >
      <div
        style={{
          backgroundColor: "var(--tandem-surface)",
          border: "1px solid var(--tandem-border)",
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          padding: "24px 28px 20px",
          width: "480px",
          maxWidth: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "16px",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "16px",
              fontWeight: 600,
              color: "var(--tandem-fg)",
            }}
          >
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            data-testid="help-modal-close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "18px",
              color: "var(--tandem-fg-muted)",
              lineHeight: 1,
              padding: "2px 6px",
              borderRadius: "4px",
            }}
          >
            ✕
          </button>
        </div>

        {SECTIONS.map((section) => (
          <div key={section.title} style={{ marginBottom: "18px" }}>
            <div
              style={{
                fontSize: "11px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--tandem-fg-subtle)",
                marginBottom: "6px",
              }}
            >
              {section.title}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.description}>
                    <td
                      style={{
                        paddingBottom: "5px",
                        paddingRight: "16px",
                        whiteSpace: "nowrap",
                        verticalAlign: "middle",
                        width: "1%",
                      }}
                    >
                      <span style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        {row.keys.map((key, i) => (
                          <span key={key}>
                            <kbd
                              style={{
                                display: "inline-block",
                                padding: "1px 6px",
                                fontSize: "12px",
                                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                background: "var(--tandem-surface-muted)",
                                border: "1px solid var(--tandem-border-strong)",
                                borderBottom: "2px solid var(--tandem-border-strong)",
                                borderRadius: "4px",
                                color: "var(--tandem-fg)",
                                lineHeight: "1.5",
                              }}
                            >
                              {key}
                            </kbd>
                            {i < row.keys.length - 1 && (
                              <span
                                style={{
                                  color: "var(--tandem-fg-subtle)",
                                  fontSize: "11px",
                                  margin: "0 2px",
                                }}
                              >
                                +
                              </span>
                            )}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td
                      style={{
                        paddingBottom: "5px",
                        fontSize: "13px",
                        color: "var(--tandem-fg-muted)",
                        verticalAlign: "middle",
                      }}
                    >
                      {row.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <div
          style={{
            marginTop: "12px",
            paddingTop: "10px",
            borderTop: "1px solid var(--tandem-border)",
            fontSize: "11px",
            color: "var(--tandem-fg-subtle)",
            textAlign: "center",
          }}
        >
          Press{" "}
          <kbd
            style={{
              fontSize: "11px",
              padding: "1px 4px",
              background: "var(--tandem-surface-muted)",
              border: "1px solid var(--tandem-border)",
              borderRadius: "3px",
              color: "var(--tandem-fg-subtle)",
            }}
          >
            ?
          </kbd>{" "}
          or{" "}
          <kbd
            style={{
              fontSize: "11px",
              padding: "1px 4px",
              background: "var(--tandem-surface-muted)",
              border: "1px solid var(--tandem-border)",
              borderRadius: "3px",
              color: "var(--tandem-fg-subtle)",
            }}
          >
            Esc
          </kbd>{" "}
          to close
        </div>
      </div>
    </div>
  );
}
