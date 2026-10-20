import { isTauriRuntime } from "../cowork/cowork-helpers";

/**
 * Whether the user is looking at this Tandem window (#2168): it is visible
 * AND it is the focused OS window — or, when the caller opts in via
 * `visibleCountsAsActive`, merely visible. A window behind other apps stays
 * `visibilityState === "visible"`, so visibility alone cannot answer this by
 * default, and a window hidden to the tray may still hold focus state from
 * before it hid, so focus alone cannot either.
 *
 * `visibleCountsAsActive` exists for side-by-side setups (Tandem next to a
 * terminal): there the user reads replies in a window that is never focused,
 * and the focus rule would notify for every one. It is read reactively, so
 * the Settings → Notifications toggle takes effect without a remount. Hidden
 * (minimised, hidden to tray, background tab) is never active either way.
 *
 * "Visible" is `pageVisible && nativeShown`. `pageVisible` is the page's
 * `visibilityState`, which is all a browser tab has. On the desktop app that
 * is not enough: WebView2 is never told its window was minimised or hidden to
 * the tray, so the page stays "visible" there (macOS minimise and Wayland
 * still rely on `visibilityState` alone). `nativeShown` is the native window's
 * own answer — `isVisible() && !isMinimized()` — and starts `true`, so the
 * browser build and a desktop window whose reads fail behave as before. The
 * read is event-driven, coalesced to one in flight plus one trailing, and
 * guarded by a sequence number so an authoritative event (focus gained, real
 * input) beats a read that was already in flight. A failed read keeps the
 * last value. Triggers: once at subscription, every native focus change,
 * `onResized` (fires on minimise on Windows and X11), `visibilitychange`, and
 * a ~2 s poll. The poll runs while `nativeShown` is false — a window shown
 * without focus (a refused `set_focus`, focus-stealing prevention) produces
 * none of the other events and would otherwise stay "hidden" forever — and,
 * with `visibleCountsAsActive` on, while the window is unfocused, because
 * hiding an unfocused window to the tray produces none of them either.
 *
 * Focus is tracked from events rather than polled through `document.hasFocus()`:
 * Playwright's focus emulation pins `hasFocus()` to true, and the events are
 * what a spec can drive. The desktop app also listens to Tauri's native focus
 * change, which is the authoritative signal there. Trusted pointer/keyboard
 * input also counts as focus AND as shown — input cannot reach a hidden
 * window — see the effect below.
 */
export interface WindowAttention {
  readonly active: boolean;
}

export interface WindowAttentionOptions {
  /** When it returns true, a visible window counts as active even unfocused. */
  visibleCountsAsActive?: () => boolean;
}

/** How often a desktop window that reads as hidden is re-read. */
export const NATIVE_HIDDEN_POLL_MS = 2_000;

/** Must be called during component initialisation: listeners live in an `$effect`. */
export function createWindowAttention(options: WindowAttentionOptions = {}): WindowAttention {
  let focused = $state(readInitialFocus());
  let pageVisible = $state(readVisible());
  let nativeShown = $state(true);
  const visible = $derived(pageVisible && nativeShown);
  const active = $derived(visible && (focused || (options.visibleCountsAsActive?.() ?? false)));

  $effect(() => {
    // Bumped on EVERY event-driven write to `focused`, so the one-shot native
    // `isFocused()` seed below can tell whether an event landed while it was
    // in flight — a newer event must win over a stale seed.
    let writes = 0;
    const setFocused = (value: boolean) => {
      writes++;
      focused = value;
      syncPoll();
    };

    let destroyed = false;
    // Native-visibility state (desktop only; `refreshNative` stays null in a
    // browser, so nothing below ever writes `nativeShown = false` there).
    let nativeSeq = 0;
    let refreshNative: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    // Polled while the window reads hidden — the one way back for a window
    // shown without focus — and, when visible-counts-as-active is on, while it
    // is unfocused: hiding an unfocused window to the tray (the taskbar's
    // "Close window") fires no focus, resize or visibility event, and with the
    // toggle on that window would otherwise stay active in the tray. Called
    // after every write to `nativeShown` or `focused`.
    const syncPoll = () => {
      const want =
        !destroyed &&
        refreshNative !== null &&
        (!nativeShown || (!focused && (options.visibleCountsAsActive?.() ?? false)));
      if (want && pollTimer === null) {
        const refresh = refreshNative;
        pollTimer = setInterval(() => refresh?.(), NATIVE_HIDDEN_POLL_MS);
      } else if (!want && pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    // Authoritative evidence the window is on screen. The sequence bump makes
    // any read already in flight — which may have sampled the window while it
    // was still hidden — discard its result.
    const markShown = () => {
      nativeSeq++;
      nativeShown = true;
      syncPoll();
    };

    const onFocus = (event: Event) => {
      if (event.target === window) setFocused(true);
    };
    const onBlur = (event: Event) => {
      if (event.target === window) setFocused(false);
    };
    // A false `document.hasFocus()` seed at load (the WebView or tab came up
    // without focus) is otherwise never corrected when the OS window never
    // blurs afterwards: no `focus` event fires for a window that, as far as
    // the OS is concerned, was focused all along. Real input proves the user
    // is here — and that the window is shown. These only ever move TOWARD
    // active, and only for trusted events — a script-dispatched event proves
    // nothing. Playwright's input is trusted, while the E2E specs' synthetic
    // `blur` is not followed by input, so the specs that simulate "away" stay
    // away. Deliberately not `focusin` (the app moves focus programmatically)
    // and not `hasFocus()` polling (Playwright pins it true).
    const onInput = (event: Event) => {
      if (!event.isTrusted) return;
      if (!focused) setFocused(true);
      markShown();
    };
    const onVisibility = () => {
      pageVisible = readVisible();
      refreshNative?.();
    };
    const inputOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onInput, inputOptions);
    window.addEventListener("keydown", onInput, inputOptions);
    document.addEventListener("visibilitychange", onVisibility);

    const unlistenTauri: Array<() => void> = [];
    if (isTauriRuntime()) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (destroyed) return;
        const win = getCurrentWindow();

        // One read in flight at most; a request during it schedules exactly
        // one trailing read, so a burst of resize events costs two IPC round
        // trips, not one per event.
        let inFlight = false;
        let trailing = false;
        let warned = false;
        // `async` so a getter that throws synchronously still lands in the
        // `.catch` below rather than escaping with `inFlight` stuck true.
        const readShown = async () => {
          const [shown, minimized] = await Promise.all([win.isVisible(), win.isMinimized()]);
          return shown && !minimized;
        };
        const refresh = () => {
          if (destroyed) return;
          if (inFlight) {
            trailing = true;
            return;
          }
          inFlight = true;
          const seq = nativeSeq;
          void readShown()
            .then((shown) => {
              if (destroyed || seq !== nativeSeq) return;
              nativeShown = shown;
              syncPoll();
            })
            .catch((err: unknown) => {
              // Keep the last value: a failed read is no evidence either way.
              if (!warned) {
                warned = true;
                console.warn("[attention] native visibility read failed:", err);
              }
            })
            .finally(() => {
              inFlight = false;
              if (trailing && !destroyed) {
                trailing = false;
                refresh();
              }
            });
        };
        refreshNative = refresh;
        syncPoll();

        const unlistenFocus = await win.onFocusChanged(({ payload }) => {
          setFocused(payload === true);
          // Focus gained proves the window is shown NOW, before any read can
          // say so; the bump drops a read that sampled it hidden.
          if (payload === true) markShown();
          refresh();
        });
        if (destroyed) {
          unlistenFocus();
          return;
        }
        // Stored BEFORE the next await, so a cleanup during it — or a later
        // rejection — cannot leak the listener.
        unlistenTauri.push(unlistenFocus);

        try {
          const unlistenResize = await win.onResized(() => refresh());
          if (destroyed) {
            unlistenResize();
            return;
          }
          unlistenTauri.push(unlistenResize);
        } catch (err: unknown) {
          console.warn("[attention] window resize listener failed:", err);
        }

        // Seed the native visibility now that every trigger is subscribed,
        // so a change between the seed and the subscriptions is not lost.
        refresh();

        // The listener reports CHANGES only, and the WebView's
        // `document.hasFocus()` seed can disagree with the native window at
        // cold start. Read the native state once, after subscribing so a
        // change in between is not lost — and apply it only if no event
        // arrived while the read was in flight.
        const before = writes;
        try {
          const native = await win.isFocused();
          if (!destroyed && writes === before) {
            focused = native;
            syncPoll();
          }
        } catch (err: unknown) {
          console.warn("[attention] native isFocused() failed:", err);
        }
      })().catch((err: unknown) => {
        console.warn("[attention] window focus listener failed:", err);
      });
    }

    return () => {
      destroyed = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onInput, inputOptions);
      window.removeEventListener("keydown", onInput, inputOptions);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const unlisten of unlistenTauri.splice(0)) unlisten();
      refreshNative = null;
      syncPoll();
    };
  });

  return {
    get active() {
      return active;
    },
  };
}

function readInitialFocus(): boolean {
  try {
    return document.hasFocus();
  } catch {
    return true;
  }
}

function readVisible(): boolean {
  try {
    return document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}
