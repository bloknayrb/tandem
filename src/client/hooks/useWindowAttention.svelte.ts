import { isTauriRuntime } from "../cowork/cowork-helpers";

/**
 * Whether the user is looking at this Tandem window (#2168): its page is
 * visible AND it is the focused OS window — or, when the caller opts in via
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
 * Focus is tracked from events rather than polled through `document.hasFocus()`:
 * Playwright's focus emulation pins `hasFocus()` to true, and the events are
 * what a spec can drive. The desktop app also listens to Tauri's native focus
 * change, which is the authoritative signal there. Trusted pointer/keyboard
 * input also counts as focus — see the effect below.
 */
export interface WindowAttention {
  readonly active: boolean;
}

export interface WindowAttentionOptions {
  /** When it returns true, a visible window counts as active even unfocused. */
  visibleCountsAsActive?: () => boolean;
}

/** Must be called during component initialisation: listeners live in an `$effect`. */
export function createWindowAttention(options: WindowAttentionOptions = {}): WindowAttention {
  let focused = $state(readInitialFocus());
  let visible = $state(readVisible());
  const active = $derived(visible && (focused || (options.visibleCountsAsActive?.() ?? false)));

  $effect(() => {
    // Bumped on EVERY event-driven write to `focused`, so the one-shot native
    // `isFocused()` seed below can tell whether an event landed while it was
    // in flight — a newer event must win over a stale seed.
    let writes = 0;
    const setFocused = (value: boolean) => {
      writes++;
      focused = value;
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
    // is here. These only ever move TOWARD active, and only for trusted
    // events — a script-dispatched event proves nothing. Playwright's input is
    // trusted, while the E2E specs' synthetic `blur` is not followed by input,
    // so the specs that simulate "away" stay away. Deliberately not `focusin`
    // (the app moves focus programmatically) and not `hasFocus()` polling
    // (Playwright pins it true).
    const onInput = (event: Event) => {
      if (event.isTrusted && !focused) setFocused(true);
    };
    const onVisibility = () => {
      visible = readVisible();
    };
    const inputOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onInput, inputOptions);
    window.addEventListener("keydown", onInput, inputOptions);
    document.addEventListener("visibilitychange", onVisibility);

    let destroyed = false;
    let unlistenTauri: (() => void) | null = null;
    if (isTauriRuntime()) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.onFocusChanged(({ payload }) => {
          setFocused(payload === true);
        });
        if (destroyed) {
          unlisten();
          return;
        }
        // Stored BEFORE the next await, so a cleanup during `isFocused()` —
        // or an `isFocused()` rejection — cannot leak the listener.
        unlistenTauri = unlisten;
        // The listener reports CHANGES only, and the WebView's
        // `document.hasFocus()` seed can disagree with the native window at
        // cold start. Read the native state once, after subscribing so a
        // change in between is not lost — and apply it only if no event
        // arrived while the read was in flight.
        const before = writes;
        try {
          const native = await win.isFocused();
          if (!destroyed && writes === before) focused = native;
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
      unlistenTauri?.();
      unlistenTauri = null;
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
