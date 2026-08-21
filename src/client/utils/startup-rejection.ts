/**
 * OS file-association open failures, surfaced as a toast.
 *
 * The user double-clicked a file (or used "Open With", or dropped it on the
 * Dock) and silently landed on `welcome.md`. This is the feedback. Rust
 * classifies the rejection and buffers a stable, PATH-FREE reason code; the
 * human-readable message is composed here, so no filesystem path reaches the
 * DOM. Mirrors the `sidecar-restart-failed` contract. See #630 and #1344.
 *
 * Extracted from `App.svelte` so it can be tested: as inline component-script
 * code it had no coverage at all, and deleting the drain — i.e. removing the
 * entire cold-start half of the feature — passed the whole suite.
 */

/** The Tauri command that TAKES the buffered reason code. */
const TAKE_COMMAND = "get_startup_rejection";

/** Payload-free nudge meaning "something is buffered, don't wait for re-init". */
const NUDGE_EVENT = "startup-file-rejected";

/**
 * Map a Rust reason code to user-facing text.
 *
 * Total over `string`, including codes this build has never heard of: a client
 * older than the Rust side must degrade to a vague-but-true message rather than
 * render a raw code. The set is pinned on the Rust side by
 * `rejection_reason_code` / `opened_url_reason_code`.
 */
export function messageForStartupRejection(code: string): string {
  switch (code) {
    case "unsupported-extension":
      return "That file type can't be opened in Tandem.";
    case "not-a-file":
    case "non-file-url":
      return "That file couldn't be opened — it may have moved or been deleted.";
    case "suspicious-path":
      return "That file path was rejected for safety reasons.";
    case "multiple-rejected":
      // A batch. Deliberately plural and reason-free: a Finder multi-select can
      // mix reasons, and naming one of them would be false rather than vague.
      return "Some of those files couldn't be opened in Tandem.";
    case "open-deferred":
      // The queue is RETAINED — `promote_healthy_and_drain` still delivers it if
      // the user restarts the server, which the failure dialog tells them how to
      // do. So this must not be past tense: "couldn't be opened" would assert a
      // finality the design deliberately does not have (#1416).
      return "Tandem couldn't open that file yet — it will open when the server starts.";
    case "multiple-deferred":
      return "Tandem couldn't open those files yet — they will open when the server starts.";
    case "open-failed":
      // The file passed shell validation and then failed to open anyway — a
      // non-2xx from `/api/open`, a transport failure, or an open that arrived
      // after the app gave up starting the server (#1416). Nothing about the
      // *file* was wrong, so the message stays deliberately vague.
      //
      // Byte-identical to `default`, and listed anyway on purpose: `default`
      // must mean exactly one thing, VERSION SKEW. Without this arm an
      // `"open_failed"` typo on the Rust side would render identically and
      // every test here would stay green — which is the desync this pair of
      // assertions (with `open_failed_code_is_stable` in `lib.rs`) exists to
      // catch.
      return "That file couldn't be opened in Tandem.";
    default:
      return "That file couldn't be opened in Tandem.";
  }
}

export interface StartupRejectionDeps {
  /** Usually `() => import("@tauri-apps/api/core")`. */
  loadCore: () => Promise<{ invoke: <T>(cmd: string) => Promise<T> }>;
  /** Usually `() => import("@tauri-apps/api/event")`. */
  loadEvent: () => Promise<{
    listen: (event: string, handler: () => void) => Promise<() => void>;
  }>;
  /**
   * Surface a composed message to the user.
   *
   * The raw `code` rides along ONLY so the caller can scope its toast dedup key
   * to it. It must not be rendered: the message is the rendered form, and the
   * whole point of the code being path-free is that nothing derived from it
   * reaches the DOM as text.
   */
  push: (message: string, code: string) => void;
  /** Injected for tests; defaults to `console.warn`. */
  warn?: (message: string, err: unknown) => void;
}

/**
 * Wire both delivery paths and return a cleanup function.
 *
 * There is ONE delivery surface — the Rust buffer — and one way to read it:
 * `get_startup_rejection`, which TAKES. Both paths below call it. The event is
 * only a nudge, so a doubled nudge cannot double-toast: whichever call arrives
 * first gets the code, the other gets `null`.
 *
 * **The init drain is deliberately chained onto the listener's resolution**, not
 * started in parallel with it. Two independent promise chains have no
 * guaranteed completion order, so a rejection landing after the drain resolved
 * but before the listener was wired would be buffered with nobody to read it —
 * and there is no second drain, because this runs once per WebView load, not on
 * an interval. Sequencing them makes the union genuinely total. `.finally` and
 * not `.then`, so a failure to wire the listener still drains anything already
 * buffered from cold start.
 */
export function wireStartupRejection(deps: StartupRejectionDeps): () => void {
  const warn = deps.warn ?? ((message: string, err: unknown) => console.warn(message, err));
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  const drain = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const { invoke } = await deps.loadCore();
      const code = await invoke<string | null>(TAKE_COMMAND);
      // A failed invoke does NOT consume the buffer — the Rust `take()` only
      // happens on success — so a transient failure self-heals on the next
      // nudge rather than losing the toast.
      if (code && !cancelled) deps.push(messageForStartupRejection(code), code);
    } catch (err) {
      warn("[App] Failed to drain buffered startup rejection:", err);
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
