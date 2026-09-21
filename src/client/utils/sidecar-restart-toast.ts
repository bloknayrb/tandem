/**
 * A successful post-boot sidecar crash-restart, surfaced as a toast.
 *
 * Since #1809 a sidecar that crashes after boot is respawned automatically. The
 * breaker trip already surfaces (`sidecar-restart-failed`), but a SUCCESSFUL
 * crash-restart emitted nothing: the user's tabs went Disconnected and silently
 * reconnected through the Hocuspocus generation gate — correct recovery, read by
 * a human as a glitch. This is the notice for it (#1959, the client half).
 *
 * The Rust side emits a payload-free event; the message is composed here, so
 * nothing from the underlying crash — a path, errno text, env var or the auth
 * token — can reach the DOM.
 *
 * Extracted from `App.svelte` rather than written inline so the notification
 * object itself is assertable: as component-script code its severity, type and
 * dedup key would have no coverage.
 */

import type { TandemNotification } from "../../shared/types";
import { listenTauriEvent, type TauriEventModule } from "./tauri-event";

/**
 * The Tauri event name. Pinned against Rust's `EVENT_SIDECAR_RESTARTED` by
 * `tests/docs/startup-open-failure-wiring-claims.test.ts`: the event is
 * payload-free, so a one-character disagreement is indistinguishable from no
 * restart having happened and would ship a dead feature with a green suite.
 */
export const SIDECAR_RESTARTED_EVENT = "sidecar-restarted";

/** Past tense: the recovery has already finished by the time this is shown. */
export const SIDECAR_RESTARTED_MESSAGE = "Tandem server restarted after a crash.";

/**
 * Build the notification this feature pushes.
 *
 * `severity: "info"` is a decision, not a default: only `info` expires
 * (`ACTIVITY_INFO_TTL_MS`), and a recovery notice that persists in the activity
 * tray outlives what it describes. `type: "general-error"` because the union has
 * no success member and the sibling `sidecar-restart-failed` listener already
 * uses it; no `errorCode`, because nothing failed. The `dedupKey` is constant so
 * three crashes inside the breaker budget collapse into one toast with a count.
 */
export function buildSidecarRestartedNotification(now: number): TandemNotification {
  return {
    id: `sidecar-restarted-${now}`,
    type: "general-error",
    severity: "info",
    message: SIDECAR_RESTARTED_MESSAGE,
    dedupKey: "sidecar-restarted",
    timestamp: now,
  };
}

export interface SidecarRestartedDeps {
  /** Usually `() => import("@tauri-apps/api/event")`. */
  loadEvent: () => Promise<TauriEventModule>;
  /** Surface the notice. Takes the built notification, not a message string. */
  push: (notification: TandemNotification) => void;
  /** Injected for tests; defaults to `console.warn`. */
  warn?: (message: string, err: unknown) => void;
}

/**
 * Wire the listener and return a cleanup function.
 *
 * There is deliberately no buffer and no drain, unlike `startup-rejection.ts`:
 * losing this notice is acceptable — it describes a recovery that has already
 * succeeded. (NOT because the WebView is always alive for it:
 * `recover_deferred_crash` can restart the sidecar before `App.svelte` mounts.)
 */
export function wireSidecarRestarted(deps: SidecarRestartedDeps): () => void {
  return listenTauriEvent({
    loadEvent: deps.loadEvent,
    event: SIDECAR_RESTARTED_EVENT,
    onEvent: () => deps.push(buildSidecarRestartedNotification(Date.now())),
    warn: deps.warn,
  });
}
