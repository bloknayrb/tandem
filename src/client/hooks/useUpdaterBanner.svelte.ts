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
/**
 * Watchdog: clear `installing` after this many ms if `app.restart()` has not
 * torn down the WebView. The install flow normally never resolves because the
 * Rust side calls `app.restart()` mid-await, which kills the page. If that
 * tear-down doesn't happen (e.g. updater plugin fails to launch the installer
 * silently on some Windows configs), the banner would otherwise stay stuck in
 * "Installing…" forever. 30s is long enough to swallow a slow download +
 * launch on a typical machine but short enough that a stuck banner re-arms
 * the CTA before the user gives up.
 */
const INSTALL_WATCHDOG_MS = 30_000;

export function createUpdaterBanner(): UpdaterBannerState {
  let installing = $state(false);
  // Captured into a const inside install() and cleared from the $effect
  // cleanup; mirrors F12's `unlistenRef` pattern so we never read $state from
  // a cleanup closure. A `null` slot represents "no watchdog armed".
  let watchdogId: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdogId !== null) {
      clearTimeout(watchdogId);
      watchdogId = null;
    }
  }

  $effect(() => {
    const unsubscribe = subscribeToUpdaterChannel();
    return () => {
      // Component teardown: drop any pending watchdog so a delayed timer
      // doesn't fire against an unmounted hook (would still be a no-op
      // write to a dead $state, but explicit cleanup is cheaper than
      // documenting why it's harmless).
      clearWatchdog();
      unsubscribe();
    };
  });

  async function install(): Promise<void> {
    const v = getAvailableVersion();
    if (!v || installing) return;
    installing = true;
    // Arm the watchdog *before* awaiting so we cover both the dynamic-import
    // and the invoke() round-trip. If `app.restart()` succeeds, the WebView
    // is torn down before this fires — the timer dies with the page.
    clearWatchdog();
    watchdogId = setTimeout(() => {
      watchdogId = null;
      installing = false;
      console.warn(
        `[useUpdaterBanner] install_update did not tear down WebView within ${INSTALL_WATCHDOG_MS}ms; re-arming CTA`,
      );
    }, INSTALL_WATCHDOG_MS);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Fire-and-forget from the JS side: on success Rust calls app.restart(),
      // which tears down the WebView; awaiting here is fine because the
      // promise simply never resolves in that case.
      await invoke("install_update");
      // If we reach this line, install resolved without a restart — clear
      // the watchdog and re-arm the CTA so the user can retry.
      clearWatchdog();
      installing = false;
    } catch (err) {
      console.warn("[useUpdaterBanner] install_update failed:", err);
      clearWatchdog();
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
