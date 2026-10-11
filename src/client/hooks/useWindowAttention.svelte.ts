import { isTauriRuntime } from "../cowork/cowork-helpers";

/**
 * Whether the user is looking at this Tandem window (#2168): it is the focused
 * OS window AND its page is visible. A window behind other apps stays
 * `visibilityState === "visible"`, so visibility alone cannot answer this, and
 * a window hidden to the tray may still hold focus state from before it hid,
 * so focus alone cannot either.
 *
 * Focus is tracked from events rather than polled through `document.hasFocus()`:
 * Playwright's focus emulation pins `hasFocus()` to true, and the events are
 * what a spec can drive. The desktop app also listens to Tauri's native focus
 * change, which is the authoritative signal there.
 */
export interface WindowAttention {
  readonly active: boolean;
}

/** Must be called during component initialisation: listeners live in an `$effect`. */
export function createWindowAttention(): WindowAttention {
  let focused = $state(readInitialFocus());
  let visible = $state(readVisible());
  const active = $derived(focused && visible);

  $effect(() => {
    const onFocus = (event: Event) => {
      if (event.target === window) focused = true;
    };
    const onBlur = (event: Event) => {
      if (event.target === window) focused = false;
    };
    const onVisibility = () => {
      visible = readVisible();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    let destroyed = false;
    let unlistenTauri: (() => void) | null = null;
    if (isTauriRuntime()) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onFocusChanged(({ payload }) => {
            focused = payload === true;
          }),
        )
        .then((unlisten) => {
          if (destroyed) unlisten();
          else unlistenTauri = unlisten;
        })
        .catch((err: unknown) => {
          console.warn("[attention] window focus listener failed:", err);
        });
    }

    return () => {
      destroyed = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
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
