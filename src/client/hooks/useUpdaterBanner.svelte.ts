import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";

/**
 * Event emitted from `src-tauri/src/lib.rs` when the periodic auto-update check
 * detects an available release. Payload is `{ version: string }`. The manual
 * "Check for Updates" tray menu still surfaces a native dialog — the banner is
 * only driven by the background event channel (D6 locked decision).
 */
export const UPDATE_AVAILABLE_EVENT = "tandem://update-available";

const DISMISS_KEY_PREFIX = "tandem:updater-dismissed-v";

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

function dismissKey(version: string): string {
  return `${DISMISS_KEY_PREFIX}${version}`;
}

function readDismissed(version: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(version)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(dismissKey(version), "1");
  } catch {
    /* localStorage may be disabled (incognito, strict modes); silently skip */
  }
}

/**
 * Subscribes to the Tauri updater event channel and exposes a banner state.
 *
 * Svelte 5 guardrail (feedback_svelte_prop_in_effect_cleanup): the `unlisten`
 * fn is captured into a `const` that the cleanup closes over; we never
 * re-read `$state` from inside the cleanup.
 *
 * Non-Tauri environments early-return a static no-op state.
 */
export function createUpdaterBanner(): UpdaterBannerState {
  let version = $state<string | null>(null);
  let installing = $state(false);
  // Re-readable in render via getter; updated when dismiss() or new version fires.
  let dismissedFor = $state<string | null>(null);

  if (isTauriRuntime()) {
    $effect(() => {
      // `unlistenRef` holds the unsubscribe fn captured at attach time. The
      // cleanup closes over this const — it never re-reads any $state.
      const unlistenRef: { fn: (() => void) | null } = { fn: null };
      let cancelled = false;

      (async () => {
        try {
          const { listen } = await import("@tauri-apps/api/event");
          if (cancelled) return;
          const off = await listen<{ version: string }>(UPDATE_AVAILABLE_EVENT, (event) => {
            const next = event.payload?.version ?? null;
            if (!next) return;
            version = next;
            // A new version supersedes any previous dismissal record.
            if (dismissedFor !== next) dismissedFor = null;
          });
          if (cancelled) {
            off();
            return;
          }
          unlistenRef.fn = off;
        } catch (err) {
          console.warn("[useUpdaterBanner] listen() failed:", err);
        }
      })();

      return () => {
        cancelled = true;
        const off = unlistenRef.fn;
        unlistenRef.fn = null;
        if (off) {
          try {
            off();
          } catch (err) {
            console.warn("[useUpdaterBanner] unlisten threw:", err);
          }
        }
      };
    });
  }

  async function install(): Promise<void> {
    const v = version;
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
      return version;
    },
    get installing() {
      return installing;
    },
    get showBanner() {
      const v = version;
      if (!v) return false;
      if (dismissedFor === v) return false;
      if (readDismissed(v)) return false;
      return true;
    },
    dismiss() {
      const v = version;
      if (!v) return;
      writeDismissed(v);
      dismissedFor = v;
    },
    install,
  };
}
