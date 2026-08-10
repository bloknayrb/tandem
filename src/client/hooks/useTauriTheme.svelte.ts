/// <reference types="vite/client" />
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { InvokeFn } from "@client/cowork/cowork-invoke.js";
import type { ThemePreference } from "./useTandemSettings.js";
import type { ResolvedTheme } from "./useTheme.js";

declare global {
  interface Window {
    __TANDEM_INITIAL_THEME__?: "light" | "dark";
  }
}

/**
 * Response shape for the `set_native_theme` Tauri command (#992 rev2).
 * `osTheme` is non-null ONLY when `overrideActive` is false — i.e. only when
 * the reading is authoritative, because Rust reads `window.theme()` AFTER
 * applying/releasing the override. That is the mechanism that lets a
 * transition back to `"system"` resolve correctly in the SAME round trip
 * instead of waiting on the 3s poll below (see `setNativeTheme`).
 */
interface NativeThemeOutcome {
  overrideActive: boolean;
  osTheme: "light" | "dark" | null;
}

class TauriThemeStore {
  current = $state<ResolvedTheme | null>(
    isTauriRuntime() ? (window.__TANDEM_INITIAL_THEME__ ?? null) : null,
  );
}

export const tauriTheme = new TauriThemeStore();

let _initialized = false;

// ----- Module-scope push/read-back state (#992 rev2, B1-B3) ---------------
//
// One cached `invoke` import, reused by both the initial `get_app_theme`
// fetch/poll (in `initTauriTheme`) and every `setNativeTheme` push, instead
// of each site doing its own `import("@tauri-apps/api/core")`.
let invokePromise: Promise<InvokeFn> | null = null;

// The 3s poll interval handle, held here (not just closed over inside
// `initTauriTheme`) so `_resetForTests()` can clear it. Pre-existing leak:
// nothing cleared this between tests, so every test that called
// `initTauriTheme()` left a live timer ticking into the next one.
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;

// Monotonic counter, bumped on every `setNativeTheme` call. Doubles as a
// "supersession" token for that call's own resolved promise AND as the
// staleness stamp async read-backs (onThemeChanged, the poll) capture at
// issue time — see `acceptReadback` below.
let pushSeq = 0;

// The last preference sent to `set_native_theme` (dedupe latch). Set
// optimistically, before the `invoke` settles, so a rerun while a push is
// still in flight short-circuits instead of duplicating it — and rolled
// back in the `.catch` so a rejected push never leaves the latch claiming a
// preference the native layer did not receive. Optimistic WITHOUT the
// rollback was a blocking rev1 finding: one rejected invoke during early
// boot would have permanently deduped away every retry.
let lastPushedPref: ThemePreference | null = null;

// Mirrors the last-resolved outcome's `overrideActive`. Gates read-backs
// (see `acceptReadback`) so an OS notification arriving while an explicit
// override is forced (macOS only — Windows always resolves `false` per the
// rev2 platform contract) isn't mistaken for a real user-driven OS change.
let overrideActive = false;

/** Stops the 3s poll if it is running. Idempotent. */
function stopPoll(): void {
  if (pollIntervalHandle !== null) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
}

/** Resets module state. Call from test teardown for vitest module isolation. */
export function _resetForTests(): void {
  tauriTheme.current = null;
  _initialized = false;
  invokePromise = null;
  pushSeq = 0;
  lastPushedPref = null;
  overrideActive = false;
  stopPoll();
  if (typeof window !== "undefined") window.__TANDEM_INITIAL_THEME__ = undefined;
}

/**
 * Module-scope memoized resolver for `@tauri-apps/api/core`'s `invoke`.
 * `initTauriTheme` and `setNativeTheme` share this one cached promise
 * instead of each doing their own `import()`. Note: `initTauriTheme` also
 * dynamically imports `@tauri-apps/api/window` for `onThemeChanged` — that
 * import is unrelated (a different module, no `invoke` export) and is NOT
 * servable from here.
 */
function getInvoke(): Promise<InvokeFn> {
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core")
      .then((m) => m.invoke as InvokeFn)
      // Never cache a REJECTED promise. A memoized rejection would make one
      // transient import failure permanent for the session: every later push
      // would reject instantly with no retry, and the dedupe latch above
      // would keep rolling back forever. Clearing the slot lets the next
      // caller re-attempt the import.
      .catch((e) => {
        invokePromise = null;
        throw e;
      });
  }
  return invokePromise;
}

/**
 * Write-through setter: keeps `tauriTheme.current` and the window bootstrap
 * seed in sync. Narrowed to "light" | "dark" -- the OS reports only those
 * two; "warm" is a user-pref-only resolved theme (W1) that never originates
 * from the OS bridge.
 *
 * Called from three sources: the initial `get_app_theme` fetch in
 * `initTauriTheme`; `acceptReadback` below (the gated path for
 * `onThemeChanged` events and the 3s poll); and `setNativeTheme`'s own
 * resolved outcome, when `osTheme` is non-null -- the release round trip,
 * which is authoritative and bypasses the read-back gate entirely (Rust
 * only sets `osTheme` once the override state settles).
 */
function setTauriTheme(next: "light" | "dark"): void {
  tauriTheme.current = next;
  if (typeof window !== "undefined") window.__TANDEM_INITIAL_THEME__ = next;
}

/**
 * Gate for ASYNCHRONOUS OS read-backs only -- `onThemeChanged` events and
 * the 3s poll. NOT used for `setNativeTheme`'s own resolved outcome, which
 * carries its own authoritative `osTheme` on release and writes through
 * unconditionally (see `setNativeTheme`).
 *
 * `seqAtIssue` must be the value of `pushSeq` captured when the read-back
 * was ISSUED (the poll's `invoke` call, or the moment an OS event was
 * received) -- not when it resolves. A read-back that started before the
 * latest push began may reflect state from before that push landed, so it
 * is discarded once a newer push has superseded it.
 *
 * `overrideActive` suppresses read-backs entirely while an explicit
 * override is forced (macOS only -- Windows always keeps `overrideActive:
 * false`, so this branch never suppresses there): any OS-level notification
 * arriving during that window is an echo of our own force, not a real
 * OS-driven change, and writing it through would corrupt `tauriTheme.current`
 * with a value the user didn't ask for.
 */
function acceptReadback(seqAtIssue: number, next: "light" | "dark"): void {
  if (seqAtIssue !== pushSeq) return; // issued before the latest push -- stale
  if (overrideActive) return; // echo of our own force (macOS only)
  setTauriTheme(next);
}

/**
 * Pushes the app's theme preference to the native window (#992) so real OS
 * surfaces match an explicit override instead of always following the OS.
 * Per the rev2 platform contract: on Windows this forces the process-wide
 * uxtheme app mode (context menus, tray menu, common dialogs, scrollbars)
 * but `overrideActive` always comes back `false` (`window.theme()` stays
 * honest, since nothing there tracks a Tandem-specific override); on macOS
 * it forces `NSApp.appearance` app-wide and `overrideActive` is `true`
 * while an explicit theme is set; on Linux this is a no-op (#1363). Called
 * on every `settings.theme` change: an explicit preference forces that
 * theme, and `"system"` clears the override so native surfaces resume
 * following the OS -- the raw, UNRESOLVED `ThemePreference` is sent
 * (`"light" | "dark" | "warm" | "system"`); Rust owns resolving `"warm"` to
 * a native theme and mapping `"system"` to "no override".
 *
 * `lastPushedPref` dedupes so the effect this feeds (`createTheme`'s merged
 * `$effect`, which also reruns on `lightVariant` churn) doesn't re-push an
 * unchanged preference. It is set OPTIMISTICALLY, before the `invoke`
 * settles, so a rerun while a push is still in flight short-circuits rather
 * than duplicating it -- and the `.catch` rolls it back, so the very next
 * call (the user re-picking the same theme, or the effect re-running) is
 * not silently swallowed by a latch describing a push that never landed.
 * `overrideActive` is the opposite: only ever assigned from a RESOLVED
 * outcome, because it describes what the native layer actually DID, and
 * that is precisely what the client must not guess -- Linux skips the push
 * entirely and Windows High Contrast declines to force. Optimistic without
 * the rollback was a blocking rev1 finding: it would have frozen both the
 * retry path and the OS read-back gate above.
 */
export function setNativeTheme(pref: ThemePreference): void {
  if (!isTauriRuntime() || pref === lastPushedPref) return;
  const seq = ++pushSeq;
  const prev = lastPushedPref;
  lastPushedPref = pref;
  getInvoke()
    .then((invoke) => invoke<NativeThemeOutcome>("set_native_theme", { theme: pref }))
    .then((outcome) => {
      if (seq !== pushSeq) return; // superseded by a later push -- discard
      overrideActive = outcome.overrideActive;
      // Authoritative: Rust reads the theme AFTER applying/releasing the
      // override, so on release this is already correct as part of THIS
      // round trip -- no need to wait on the 3s poll (acceptReadback above).
      if (outcome.osTheme) setTauriTheme(outcome.osTheme);
    })
    .catch((e) => {
      if (seq === pushSeq) {
        lastPushedPref = prev;
        overrideActive = false;
      }
      console.warn("[useTauriTheme] set_native_theme failed:", e);
    });
}

/** Initialize the Tauri theme bridge. Called once on first import in Tauri. */
export function initTauriTheme(): void {
  if (_initialized || !isTauriRuntime()) return;
  _initialized = true;

  // Resolve invoke once; reuse the cached reference in the polling interval.
  let invokeRef: InvokeFn | null = null;

  getInvoke()
    .then((invoke) => {
      invokeRef = invoke;
      invoke<string>("get_app_theme")
        .then((theme) => {
          setTauriTheme(theme === "dark" ? "dark" : "light");
        })
        .catch((e) => {
          console.warn("[useTauriTheme] get_app_theme failed:", e);
        });
    })
    .catch((e) => {
      console.warn("[useTauriTheme] Tauri API import failed:", e);
    });

  // Subscribe to onThemeChanged events
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onThemeChanged(({ payload: theme }) => {
          // Issue and delivery are the same instant here -- the payload
          // arrives with the event -- so the stamp is just the current
          // `pushSeq`. The poll below has a real gap and must capture it
          // before its `invoke`.
          acceptReadback(pushSeq, theme === "dark" ? "dark" : "light");
        })
        .catch((e) => {
          console.warn("[useTauriTheme] onThemeChanged subscribe failed:", e);
        });
    })
    .catch((e) => {
      console.warn("[useTauriTheme] Tauri window API import failed:", e);
    });

  // 3-second polling fallback while focused -- onThemeChanged reliability
  // on Windows app-mode-only flips is undocumented and unverified. Skipped
  // entirely while an override is forced: the round trip would just be
  // discarded by acceptReadback's overrideActive check, so there's no
  // reason to make the IPC call at all.
  let pollErrorLogged = false;
  pollIntervalHandle = setInterval(() => {
    if (!document.hasFocus() || !invokeRef || overrideActive) return;
    const seq = pushSeq; // captured BEFORE the async invoke -- see acceptReadback
    invokeRef("get_app_theme")
      .then((theme) => {
        const resolved: "light" | "dark" = theme === "dark" ? "dark" : "light";
        acceptReadback(seq, resolved);
        pollErrorLogged = false;
      })
      .catch((e) => {
        if (!pollErrorLogged) {
          console.warn("[useTauriTheme] theme poll failed (further errors suppressed):", e);
          pollErrorLogged = true;
        }
      });
  }, 3000);

  // Clean up the polling interval. pagehide is more reliable than unload in
  // Chromium-based environments (including Tauri's WebView2).
  //
  // HMR dispose is a DEV-MODE WART, not app teardown -- Vite re-evaluates
  // this module on hot-reload, which resets in-memory state
  // (`lastPushedPref`, `overrideActive`, `pushSeq` all go back to their
  // initial values) but does NOT release the native override: Rust's forced
  // app mode / NSApp.appearance is process-global and outlives the JS
  // module swap. So immediately after a hot-reload, this module may believe
  // nothing has been pushed yet while the OS surfaces are still showing a
  // theme forced before the reload, until the next real `setNativeTheme`
  // call reconciles it. (Rev1 conflated HMR dispose with app teardown --
  // they are not the same event.)
  window.addEventListener("pagehide", stopPoll, { once: true });
  import.meta.hot?.dispose(stopPoll);
}
