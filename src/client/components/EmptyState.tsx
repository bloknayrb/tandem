import { useEffect, useState } from "react";
import { DISCONNECT_DEBOUNCE_MS } from "../../shared/constants";

interface EmptyStateProps {
  connected: boolean;
  claudeActive: boolean;
}

/** Connection-aware empty state shown when no document is open. */
export function EmptyState({ connected, claudeActive }: EmptyStateProps) {
  const [showDisconnected, setShowDisconnected] = useState(false);

  useEffect(() => {
    if (connected) {
      setShowDisconnected(false);
      return;
    }
    const timer = setTimeout(() => setShowDisconnected(true), DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--tandem-fg-subtle)",
        gap: "8px",
      }}
    >
      {showDisconnected ? (
        <span>Cannot reach the Tandem server. Is it running?</span>
      ) : (
        <>
          <span>No document open. Click + in the tab bar or drop a file here.</span>
          {connected && !claudeActive && (
            <span style={{ fontSize: "0.85em", color: "var(--tandem-fg-subtle)" }}>
              Tip: open Claude Code in this directory to start collaborating
            </span>
          )}
        </>
      )}
    </div>
  );
}
