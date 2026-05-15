import {
  acknowledgeVersion,
  getAcknowledgedFor,
  getAvailableVersion,
  readDismissed,
  subscribeToUpdaterChannel,
  UPDATE_AVAILABLE_EVENT,
} from "@client/hooks/useUpdaterChannel.svelte.js";

// Re-exported for back-compat with any direct imports of the event name.
export { UPDATE_AVAILABLE_EVENT };

export interface UpdaterBannerState {
  /** Latest version reported by the updater, or `null` if none / dismissed. */
  readonly availableVersion: string | null;
  /** Whether install is currently in flight (CTA disabled). */
  readonly installing: boolean;
  /** True iff the banner should render right now. */
  readonly showBanner: boolean;
  dismiss: () => void;
  install: () => Promise<void>;
}

/**
 * Subscribes to the shared updater channel (see useUpdaterChannel.svelte.ts)
 * and exposes a banner state. Acknowledgements are cross-surface synced with
 * `createUpdateAvailable` (the titlebar dot): dismissing the banner also
 * clears the dot live, and opening settings clears the banner live.
 *
 * Non-Tauri environments still subscribe (the channel is a no-op there) so
 * the consumer surface is identical across runtimes; `showBanner` simply
 * stays `false` because no event ever fires.
 */
export function createUpdaterBanner(): UpdaterBannerState {
  let installing = $state(false);

  $effect(() => {
    const unsubscribe = subscribeToUpdaterChannel();
    return unsubscribe;
  });

  async function install(): Promise<void> {
    const v = getAvailableVersion();
    if (!v || installing) return;
    installing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Fire-and-forget from the JS side: on success Rust calls app.restart(),
      // which tears down the WebView; awaiting here is fine because the
      // promise simply never resolves in that case.
      await invoke("install_update");
    } catch (err) {
      console.warn("[useUpdaterBanner] install_update failed:", err);
      installing = false;
    }
  }

  return {
    get availableVersion() {
      return getAvailableVersion();
    },
    get installing() {
      return installing;
    },
    get showBanner() {
      const v = getAvailableVersion();
      if (!v) return false;
      if (getAcknowledgedFor() === v) return false;
      if (readDismissed(v)) return false;
      return true;
    },
    dismiss() {
      acknowledgeVersion(getAvailableVersion());
    },
    install,
  };
}
