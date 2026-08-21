/**
 * "Your update may not have completed" — the client half of #1118.
 *
 * The Tauri shell writes a marker before an update installs and reads it on the
 * next boot. If the running version is not the version that was being installed,
 * the install did not take (or the shell relaunched into the old binary), and
 * the Rust side buffers a stable, VERSION-FREE reason code. The human-readable
 * message is composed here, so nothing but a code crosses to the DOM.
 *
 * Sibling of `startup-rejection.ts`, deliberately: same take-once contract, same
 * buffer-plus-payload-free-nudge shape, same reason (the classification happens
 * in `setup()`, before this WebView exists). Extracted from the component for
 * the same reason too — as inline component-script code it would have no
 * coverage at all.
 *
 * **The CTA is the remediation, not a convenience.** On the boot this feature
 * exists for, the sidecar did not come up, and the Rust side's launch-time
 * update check sits behind `start_sidecar`'s failure `return` while the periodic
 * task discards its first immediate tick — so nothing re-offers the update for
 * eight hours. `requestUpdateCheck` is the only way out inside that window,
 * which is why it is pinned by its own test.
 */

/** The Tauri command that TAKES the buffered hint code. */
const TAKE_COMMAND = "get_pending_update_hint";

/** The Tauri command behind the banner's "Check for updates" CTA. */
const CHECK_COMMAND = "check_for_update_now";

/** Payload-free nudge meaning "something is buffered, don't wait for re-init". */
const NUDGE_EVENT = "pending-update-hint";

/**
 * Map a Rust reason code to user-facing text.
 *
 * Total over `string`, including codes this build has never heard of: a client
 * older than the Rust side must degrade to a vague-but-true message rather than
 * render a raw code.
 *
 * Past tense, and version-free. Past tense because a banner outlives the moment
 * it describes. Version-free because the client cannot name the running version
 * (`APP_VERSION` is a tsup/server-only define, absent from the Vite build) and
 * because the buffer deliberately carries a code, not a payload.
 */
export function messageForPendingUpdate(code: string): string {
  switch (code) {
    case "update-may-not-have-completed":
      return "Tandem may not have finished updating — it restarted on the previous version.";
    default:
      return "Tandem may not have finished updating.";
  }
}

export interface PendingUpdateDeps {
  /** Usually `() => import("@tauri-apps/api/core")`. */
  loadCore: () => Promise<{ invoke: <T>(cmd: string) => Promise<T> }>;
  /** Usually `() => import("@tauri-apps/api/event")`. */
  loadEvent: () => Promise<{
    listen: (event: string, handler: () => void) => Promise<() => void>;
  }>;
  /** Called with the composed message when a hint is drained. */
  onHint: (message: string) => void;
  /** Injected for tests; defaults to `console.warn`. */
  warn?: (message: string, err: unknown) => void;
}

/**
 * Wire both delivery paths and return a cleanup function.
 *
 * There is ONE delivery surface — the Rust buffer — and one way to read it:
 * `get_pending_update_hint`, which TAKES. Both paths below call it, so a doubled
 * nudge cannot double-raise the banner: whichever call arrives first gets the
 * code, the other gets `null`.
 *
 * **The init drain is chained onto the listener's resolution**, not started in
 * parallel with it. Two independent promise chains have no guaranteed completion
 * order, so a hint landing after the drain resolved but before the listener was
 * wired would sit buffered with nobody to read it — and there is no second
 * drain, because this runs once per WebView load, not on an interval.
 *
 * What guarantees the drain still runs when the listener FAILS to wire is the
 * `.catch` immediately before it, which converts that rejection into a
 * fulfilment. `.finally` rather than `.then` buys exactly one additional case on
 * top of that — a `warn` callback that itself throws — which is unreachable with
 * the production `console.warn` and is therefore pinned by no test. Do not
 * "restore" a stronger claim here: an earlier revision asserted that `.then`
 * would lose the boot drain, and that is simply false.
 */
export function wirePendingUpdateHint(deps: PendingUpdateDeps): () => void {
  const warn = deps.warn ?? ((message: string, err: unknown) => console.warn(message, err));
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  const drain = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const { invoke } = await deps.loadCore();
      const code = await invoke<string | null>(TAKE_COMMAND);
      // A failed invoke does NOT consume the buffer: the Rust `take()` only
      // happens on success, so the code survives in the buffer for the rest of
      // this WebView's life and a reload will still find it.
      //
      // It does NOT "self-heal on the next nudge" — there is no next nudge. The
      // only `pending-update-hint` emit fires inside Rust's `setup()`, before
      // this WebView exists, and nothing re-emits. So if this drain rejects and
      // the WebView is never reloaded, the hint is lost for good: the marker on
      // disk was already deleted by the same `setup()` pass that buffered the
      // code. That is the accepted cost of one-shot; see ADR-043's residual list.
      if (code && !cancelled) deps.onHint(messageForPendingUpdate(code));
    } catch (err) {
      warn("[App] Failed to drain buffered pending-update hint:", err);
    }
  };

  deps
    .loadEvent()
    .then(({ listen }) =>
      listen(NUDGE_EVENT, () => {
        void drain();
      }),
    )
    .then((un) => {
      if (cancelled) un();
      else unlisten = un;
    })
    .catch((err) => {
      warn(`[App] Failed to wire ${NUDGE_EVENT} listener:`, err);
    })
    .finally(() => {
      void drain();
    });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Ask the shell to check for updates now — the banner's CTA.
 *
 * Never throws: the caller is a click handler on a banner whose whole job is to
 * report that something already went wrong, so a rejected invoke must not
 * become an unhandled rejection on top of it.
 */
export async function requestUpdateCheck(
  loadCore: PendingUpdateDeps["loadCore"],
  warn: (message: string, err: unknown) => void = (m, e) => console.warn(m, e),
): Promise<void> {
  try {
    const { invoke } = await loadCore();
    await invoke<void>(CHECK_COMMAND);
  } catch (err) {
    warn("[App] Failed to request an update check:", err);
  }
}
