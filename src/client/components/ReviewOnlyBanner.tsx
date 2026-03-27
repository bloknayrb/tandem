import { useState } from "react";

const DISMISS_KEY = "tandem:reviewOnlyBannerDismissed";

interface ReviewOnlyBannerProps {
  visible: boolean;
}

export function ReviewOnlyBanner({ visible }: ReviewOnlyBannerProps) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "true");

  if (!visible || dismissed) return null;

  return (
    <div
      data-testid="review-only-banner"
      style={{
        padding: "8px 16px",
        backgroundColor: "#eff6ff",
        borderBottom: "1px solid #bfdbfe",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "13px",
        color: "#1e40af",
      }}
    >
      <span>
        This document is open in review-only mode. You can add annotations and review, but cannot
        edit directly.
      </span>
      <button
        type="button"
        data-testid="review-only-dismiss"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "true");
          setDismissed(true);
        }}
        style={{
          background: "none",
          border: "none",
          color: "#1e40af",
          cursor: "pointer",
          fontWeight: 500,
          fontSize: "13px",
          padding: "2px 8px",
          whiteSpace: "nowrap",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
