import { useEffect, useState } from "react";
import { PROLONGED_DISCONNECT_MS } from "../../shared/constants";

interface ConnectionBannerResult {
  /** True when the prolonged-disconnect banner should be visible. */
  showBanner: boolean;
  /** Call to permanently hide the banner for the current disconnect episode. */
  dismiss: () => void;
}

/**
 * Tracks prolonged-disconnect state and surfaces a dismissible banner signal.
 *
 * Shows after PROLONGED_DISCONNECT_MS of continuous disconnection.
 * Resets (hidden, undismissed) when the connection recovers.
 */
export function useConnectionBanner(disconnectedSince: number | null): ConnectionBannerResult {
  const [showDisconnectBanner, setShowDisconnectBanner] = useState(false);
  const [disconnectBannerDismissed, setDisconnectBannerDismissed] = useState(false);

  useEffect(() => {
    if (disconnectedSince == null) {
      setShowDisconnectBanner(false);
      setDisconnectBannerDismissed(false);
      return;
    }
    const elapsed = Date.now() - disconnectedSince;
    const remaining = PROLONGED_DISCONNECT_MS - elapsed;
    if (remaining <= 0) {
      setShowDisconnectBanner(true);
      return;
    }
    const timer = setTimeout(() => setShowDisconnectBanner(true), remaining);
    return () => clearTimeout(timer);
  }, [disconnectedSince]);

  return {
    showBanner: showDisconnectBanner && !disconnectBannerDismissed,
    dismiss: () => setDisconnectBannerDismissed(true),
  };
}
