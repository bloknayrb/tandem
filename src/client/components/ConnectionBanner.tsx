interface ConnectionBannerProps {
  onDismiss: () => void;
}

/** Red banner shown after prolonged disconnect (>30s). Dismissible. */
export function ConnectionBanner({ onDismiss }: ConnectionBannerProps) {
  return (
    <div
      style={{
        padding: "8px 16px",
        background: "var(--tandem-error-bg)",
        borderBottom: "1px solid var(--tandem-error-border)",
        fontSize: "13px",
        color: "var(--tandem-error-fg-strong)",
        textAlign: "center",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <span>Connection to the Tandem server has been lost. Ensure the server is running.</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--tandem-error-fg-strong)",
          fontSize: "16px",
          lineHeight: 1,
          padding: "0 4px",
        }}
        aria-label="Dismiss connection banner"
      >
        ×
      </button>
    </div>
  );
}
