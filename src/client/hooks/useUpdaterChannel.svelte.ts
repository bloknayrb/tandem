import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";

/**
 * Shared primitive consumed by `createUpdaterBanner` (Unit 8, PR #669) and
 * `createUpdateAvailable` (Unit 10, PR #675).
 *
 * Both hooks need to:
 *   1. Subscribe to the Tauri `tandem://update-available` event.
 *   2. Track the latest reported version reactively.
 *   3. Read/write the same `tandem:updater-dismissed-v{version}` localStorage
 *      key so that "dismiss the banner" and "open settings to ack the dot" are
 *      cross-surface synced.
 *
 * Doing this twice meant two parallel `$effect`-based listeners, two copies of
 * the `unlistenRef`/`cancelled` boilerplate, and per-hook acknowledgement state
 * that could not see the other surface's mutation — dismissing the banner would
 * NOT clear the dot until the next mount.
 *
 * This module hoists the listener + ack state to a module singleton so both
 * consumers observe the same reactive `version` and the same `acknowledgedFor`
 * signal. A `subscribe()` ref-count keeps the underlying Tauri listener alive
 * exactly as long as at least one consumer is mounted.
 *
 * Svelte 5 guardrails:
 *   - `subscribe()` returns an unsubscribe fn captured into a `const` so
 *     consumers can call it from `$effect` cleanup without reading any `$state`
 *     (feedback_svelte_prop_in_effect_cleanup).
 *   - The async dynamic-import path uses a `cancelled` flag flipped on full
 *     teardown so a listener attached after the last unsubscribe is torn down
 *     immediately.
 */
export const UPDATE_AVAILABLE_EVENT = "tandem://update-available";

const DISMISS_KEY_PREFIX = "tandem:updater-dismissed-v";

function dismissKey(version: string): string {
  return `${DISMISS_KEY_PREFIX}${version}`;
}

/** Reads the persisted dismissal flag for `version`. localStorage may be
 * disabled (incognito, strict modes); failure returns `false` rather than
 * throwing. */
export function readDismissed(version: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(version)) === "1";
  } catch {
    return false;
  }
}

/** Writes the persisted dismissal flag for `version`. Silently no-ops if
 * localStorage is unavailable. */
export function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(dismissKey(version), "1");
  } catch {
    /* localStorage may be disabled (incognito, strict modes); silently skip */
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-singleton reactive state.
//
// `version` is the latest version reported by the updater event channel.
// `acknowledgedFor` tracks the version that has been ack'd in-memory this
// session (either via banner-dismiss or settings-open). Both consumer hooks
// expose getters that close over this state, so a mutation from either
// surface is observed by the other on the next reactive read.
// ──────────────────────────────────────────────────────────────────────────────
let version = $state<string | null>(null);
let acknowledgedFor = $state<string | null>(null);

let refCount = 0;
let unlisten: (() => void) | null = null;
let cancelled = false;

/** Returns the latest version reported by the updater, or `null` if none. */
export function getAvailableVersion(): string | null {
  return version;
}

/** Returns the in-memory ack signal — the version that has been ack'd this
 * session, or `null`. */
export function getAcknowledgedFor(): string | null {
  return acknowledgedFor;
}

/**
 * Marks `v` as acknowledged in-memory AND persists the dismissal flag so the
 * ack survives a reload. Called from the banner's dismiss and from
 * settings-open. Both consumer hooks observe the in-memory `acknowledgedFor`
 * reactively so the cross-surface sync is live, not just on next mount.
 */
export function acknowledgeVersion(v: string | null): void {
  if (!v) return;
  writeDismissed(v);
  acknowledgedFor = v;
}

/**
 * Subscribes to the Tauri updater event channel. Reference-counted: the first
 * subscribe attaches the listener, the last unsubscribe detaches it.
 *
 * Returns an unsubscribe function. Call from `$effect` cleanup; never throws.
 *
 * Outside Tauri, no listener is attached but the ref-count is still tracked
 * so the return type is consistent.
 */
export function subscribeToUpdaterChannel(): () => void {
  refCount += 1;
  if (refCount === 1 && isTauriRuntime()) {
    cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen<{ version: string }>(UPDATE_AVAILABLE_EVENT, (event) => {
          const next = event.payload?.version ?? null;
          if (!next) return;
          version = next;
          // A new version supersedes any previous in-memory ack. Persisted
          // per-version dismissals (localStorage) are still checked by the
          // consumer-side `showDot`/`showBanner` getters.
          if (acknowledgedFor !== next) acknowledgedFor = null;
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch (err) {
        console.warn("[useUpdaterChannel] listen() failed:", err);
      }
    })();
  }
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      cancelled = true;
      const off = unlisten;
      unlisten = null;
      if (off) {
        try {
          off();
        } catch (err) {
          console.warn("[useUpdaterChannel] unlisten threw:", err);
        }
      }
    }
  };
}

/**
 * Test-only reset. Clears the singleton state so tests can simulate a fresh
 * process. Not exported from the public surface of either consumer hook.
 */
export function __resetUpdaterChannelForTests(): void {
  version = null;
  acknowledgedFor = null;
  refCount = 0;
  cancelled = true;
  const off = unlisten;
  unlisten = null;
  if (off) {
    try {
      off();
    } catch {
      /* swallow */
    }
  }
}
