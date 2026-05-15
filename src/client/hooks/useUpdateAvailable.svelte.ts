import {
  acknowledgeVersion,
  getAcknowledgedFor,
  getAvailableVersion,
  readDismissed,
  subscribeToUpdaterChannel,
  UPDATE_AVAILABLE_EVENT,
} from "@client/hooks/useUpdaterChannel.svelte.js";

/**
 * Titlebar settings-icon update-available dot badge (issue #660, D6 sub-piece).
 *
 * Pairs with the in-app updater banner (`createUpdaterBanner`, Unit 8). Both
 * surfaces share the same module-level listener + acknowledgement state via
 * `useUpdaterChannel.svelte.ts`, so dismissing the banner clears the dot live
 * and opening settings clears the banner live. The shared primitive also keeps
 * the Tauri listener attached exactly once regardless of how many surfaces
 * subscribe.
 *
 * Security: Event source is `@tauri-apps/plugin-updater` only — never a
 * postMessage, MCP channel event, or Hocuspocus signal. Render is gated on
 * `isTauriRuntime()` in TitleBar (defence in depth — the channel never fires
 * outside Tauri either).
 */
// Re-exported for back-compat with any direct imports of the event name.
export { UPDATE_AVAILABLE_EVENT };

export interface UpdateAvailableState {
  /** Latest version reported by the updater, or `null` if none / acknowledged. */
  readonly availableVersion: string | null;
  /** True iff the dot should render right now. */
  readonly showDot: boolean;
  /**
   * Acknowledge the current update — called when the user opens settings (any
   * tab) or dismisses the paired banner. Writes the same localStorage key the
   * banner uses so both surfaces stay in sync.
   *
   * Do NOT destructure this return value — the `showDot` / `availableVersion`
   * getters lose reactivity when destructured (see
   * feedback_svelte_getter_destructuring).
   */
  acknowledge: () => void;
}

/**
 * Subscribes to the shared updater channel and exposes the dot-badge state.
 * Non-Tauri environments still subscribe (the channel is a no-op there);
 * `showDot` simply stays `false` because no event fires.
 */
export function createUpdateAvailable(): UpdateAvailableState {
  $effect(() => {
    const unsubscribe = subscribeToUpdaterChannel();
    return unsubscribe;
  });

  return {
    get availableVersion() {
      return getAvailableVersion();
    },
    get showDot() {
      const v = getAvailableVersion();
      if (!v) return false;
      if (getAcknowledgedFor() === v) return false;
      if (readDismissed(v)) return false;
      return true;
    },
    acknowledge() {
      acknowledgeVersion(getAvailableVersion());
    },
  };
}
