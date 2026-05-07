import { PROLONGED_DISCONNECT_MS } from "../../shared/constants.js";

export interface ConnectionBannerState {
  readonly showBanner: boolean;
  dismiss: () => void;
}

/**
 * Svelte 5 port of `useConnectionBanner`.
 *
 * Tracks prolonged-disconnect state and surfaces a dismissible banner signal.
 * Shows after `getDelayMs()` ms of continuous disconnection (defaults to
 * PROLONGED_DISCONNECT_MS). Resets when the connection recovers.
 *
 * Accepts getters so callers with `$state` values propagate reactively.
 */
export function createConnectionBanner(
  getDisconnectedSince: () => number | null,
  getDelayMs: () => number = () => PROLONGED_DISCONNECT_MS,
): ConnectionBannerState {
  let showDisconnectBanner = $state(false);
  let disconnectBannerDismissed = $state(false);

  $effect(() => {
    const disconnectedSince = getDisconnectedSince();
    if (disconnectedSince == null) {
      showDisconnectBanner = false;
      disconnectBannerDismissed = false;
      return;
    }
    const elapsed = Date.now() - disconnectedSince;
    const remaining = getDelayMs() - elapsed;
    if (remaining <= 0) {
      showDisconnectBanner = true;
      return;
    }
    const timer = setTimeout(() => {
      showDisconnectBanner = true;
    }, remaining);
    return () => clearTimeout(timer);
  });

  return {
    get showBanner() {
      return showDisconnectBanner && !disconnectBannerDismissed;
    },
    dismiss() {
      disconnectBannerDismissed = true;
    },
  };
}
