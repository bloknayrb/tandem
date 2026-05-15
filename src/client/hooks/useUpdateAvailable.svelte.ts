import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";

/**
 * Titlebar settings-icon update-available dot badge (issue #660, D6 sub-piece).
 *
 * Pairs with the in-app updater banner from Unit 8 (PR #669). Both surfaces
 * listen to the same Tauri updater event and share the same
 * `tandem:updater-dismissed-v{version}` localStorage key — dismissing the
 * banner or opening settings acknowledges the dot, and vice-versa. The two
 * listeners are intentionally separate during Wave 2 so the units can land
 * independently; a follow-up consolidates them after #669 merges.
 *
 * Security: Event source is `@tauri-apps/plugin-updater` only — never a
 * postMessage, MCP channel event, or Hocuspocus signal. Render is gated on
 * `isTauriRuntime()` in TitleBar (defence in depth — the listener never
 * attaches in non-Tauri builds either).
 */
export const UPDATE_AVAILABLE_EVENT = "tandem://update-available";

const DISMISS_KEY_PREFIX = "tandem:updater-dismissed-v";

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
 * Subscribes to the Tauri updater event channel and exposes the dot-badge
 * state. Non-Tauri environments return a static no-op (listener never
 * attaches; `showDot` is always `false`).
 *
 * Svelte 5 guardrails (feedback_svelte_prop_in_effect_cleanup,
 * feedback_svelte_onmount_async_test_flush):
 *   - The Tauri `unlisten` fn is captured into a ref object that the cleanup
 *     closes over — cleanup never re-reads `$state` or props.
 *   - The async dynamic-import path uses a `cancelled` flag flipped on
 *     cleanup so a listener attached after unmount is immediately torn down.
 */
export function createUpdateAvailable(): UpdateAvailableState {
  let version = $state<string | null>(null);
  // Bumped every time `acknowledge()` runs so `showDot` re-evaluates without
  // having to mutate `version` (the banner cares about `version` separately).
  let acknowledgedFor = $state<string | null>(null);

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
            // A new version supersedes any prior in-session acknowledgement.
            // Persisted dismissals (localStorage) are still keyed per-version
            // and are checked in the `showDot` getter.
            if (acknowledgedFor !== next) acknowledgedFor = null;
          });
          if (cancelled) {
            off();
            return;
          }
          unlistenRef.fn = off;
        } catch (err) {
          console.warn("[useUpdateAvailable] listen() failed:", err);
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
            console.warn("[useUpdateAvailable] unlisten threw:", err);
          }
        }
      };
    });
  }

  return {
    get availableVersion() {
      return version;
    },
    get showDot() {
      const v = version;
      if (!v) return false;
      if (acknowledgedFor === v) return false;
      if (readDismissed(v)) return false;
      return true;
    },
    acknowledge() {
      const v = version;
      if (!v) return;
      // Writes the SAME key shape the banner uses so opening settings also
      // dismisses the banner (and dismissing the banner also clears the dot).
      writeDismissed(v);
      acknowledgedFor = v;
    },
  };
}
