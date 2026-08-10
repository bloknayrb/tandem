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
 * Response shape for the `set_native_theme` Tauri command (#992).
 * `osTheme` is non-null ONLY when `overrideActive` is false — i.e. only when
 * the reading is authoritative, because Rust reads `window.theme()` AFTER
 * applying/releasing the override. That is the mechanism that lets a
 * transition back to `"system"` resolve correctly in the SAME round trip
 * instead of waiting on the 3s poll below (see `setNativeTheme`).
 *
 * Expressed as a discriminated union rather than a flat struct so that
 * contract is enforced by the compiler instead of by this comment:
 * `{ overrideActive: true, osTheme: "dark" }` is exactly the pair that would
 * write an echo of our own force into `tauriTheme.current`, and it must not
 * type-check. Serde cannot express this from the Rust side's flat struct, but
 * TypeScript is the consumer and is free to be stricter than the producer.
 */
type NativeThemeOutcome =
  | { overrideActive: true; osTheme: null }
  | { overrideActive: false; osTheme: "light" | "dark" | null };

class TauriThemeStore {
  current = $state<ResolvedTheme | null>(
    isTauriRuntime() ? (window.__TANDEM_INITIAL_THEME__ ?? null) : null,
  );
}

export const tauriTheme = new TauriThemeStore();

let _initialized = false;

// ----- Module-scope push/read-back state (#992) ---------------------------
//
// NOTE: these encode one concept — the state of the push pipeline — as
// separate fields whose cross-invariants are held by the comments below
// rather than by the types. #1369 restructures them into `inFlight` /
// `lastResolved`, which makes those invariants structural. Do that BEFORE
// adding another variable here, not after.
//
// One cached `invoke` import, reused by both the initial `get_app_theme`
// fetch/poll (in `initTauriTheme`) and every `setNativeTheme` push, instead
// of each site doing its own `import("@tauri-apps/api/core")`.
let invokePromise: Promise<InvokeFn> | null = null;

// The 3s poll interval handle, held here (not just closed over inside
// `initTauriTheme`) so `_resetForTests()` can clear it.
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;

// Monotonic counter, bumped on every `setNativeTheme` call. Doubles as a
// "supersession" token for that call's own resolved promise AND as the
// staleness stamp async read-backs (onThemeChanged, the poll) capture at
// issue time — see `acceptReadback` below.
let pushSeq = 0;

// The last preference sent to `set_native_theme` (dedupe latch), set
// optimistically before the `invoke` settles so a rerun while a push is
// still in flight short-circuits instead of duplicating it.
//
// On rejection it is cleared to `null` — NOT restored to its previous value.
// Restoring the previous value is a *guess* that the failed push never
// landed, and the guess inverts in the case that actually happens: a
// `recv_timeout` in Rust's `apply_app_mode` abandons the wait but does not
// cancel the queued closure, so the mode can apply a moment later. The latch
// would then claim the old preference while the OS holds the new one, and
// re-picking the old one would be deduped away forever. `null` means "no
// claim", which is the only honest state after a failure and guarantees the
// next push proceeds whatever its value.
let lastPushedPref: ThemePreference | null = null;

// Mirrors the last-RESOLVED outcome's `overrideActive`, and is never written
// from a rejected push: it describes what the native layer actually did, which
// is precisely what the client cannot guess. Gates read-backs (see
// `acceptReadback`) so an OS notification arriving while an explicit override
// is forced (macOS only — Windows always resolves `false`) isn't mistaken for
// a real user-driven OS change.
let overrideActive = false;

// Bounded retry for a rejected push. Without this, a failed *release* would
// leave `overrideActive` true, which suppresses both the 3s poll and every
// `onThemeChanged` — so `tauriTheme.current` would stop moving and the app's
// own `data-theme` would stop following the OS for the rest of the session.
// Capped and cancelled on supersession so a persistently failing invoke
// cannot hot-loop.
const MAX_PUSH_RETRIES = 3;
const RETRY_BASE_MS = 500;
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;

/** Cancels a scheduled push retry, if any. Idempotent. */
function cancelRetry(): void {
  if (retryHandle !== null) {
    clearTimeout(retryHandle);
    retryHandle = null;
  }
}

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
  retryAttempts = 0;
  cancelRetry();
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
 * Per the platform contract: on Windows this forces the process-wide
 * uxtheme app mode (context menus and the tray menu) but `overrideActive`
 * always comes back `false` (`window.theme()` stays honest -- tao reads the
 * `AppsUseLightTheme` registry value before consulting uxtheme, so our app
 * mode cannot echo into it); on macOS it forces `NSApp.appearance` app-wide
 * and `overrideActive` is `true` while an explicit theme is set; on Linux
 * the Rust side resolves to a no-op action (#1363) -- the client pushes
 * identically on every platform. Called
 * on every `settings.theme` change: an explicit preference forces that
 * theme, and `"system"` clears the override so native surfaces resume
 * following the OS -- the raw, UNRESOLVED `ThemePreference` is sent
 * (`"light" | "dark" | "warm" | "system"`); Rust owns resolving `"warm"` to
 * a native theme and mapping `"system"` to "no override".
 *
 * `lastPushedPref` dedupes so the effect this feeds (`createTheme`'s merged
 * `$effect`, which also reruns on `lightVariant` churn) doesn't re-push an
 * unchanged preference. It is set OPTIMISTICALLY, before the `invoke`
 * settles, and cleared to `null` on rejection -- see its declaration for why
 * `null` rather than the previous value. `overrideActive` is deliberately
 * NOT touched on rejection: a failed push means the native override state is
 * UNKNOWN, and leaving read-backs suppressed is stale-but-recoverable, where
 * admitting an echo of a force we may not have released is corrupt and
 * self-reinforcing via the poll.
 *
 * Note the latch does not prevent duplicate *concurrent* pushes: a stale
 * rejection can clear it while a newer push is still in flight. That is
 * harmless -- the native operation is idempotent.
 */
export function setNativeTheme(pref: ThemePreference): void {
  if (!isTauriRuntime() || pref === lastPushedPref) return;
  const seq = ++pushSeq;
  cancelRetry(); // a newer push supersedes any pending retry
  lastPushedPref = pref;
  getInvoke()
    .then((invoke) => invoke<NativeThemeOutcome>("set_native_theme", { theme: pref }))
    .then((outcome) => {
      if (seq !== pushSeq) return; // superseded by a later push -- discard
      overrideActive = outcome.overrideActive;
      retryAttempts = 0;
      // Authoritative: Rust reads the theme AFTER applying/releasing the
      // override, so on release this is already correct as part of THIS
      // round trip -- no need to wait on the 3s poll (acceptReadback above).
      if (outcome.osTheme) setTauriTheme(outcome.osTheme);
    })
    .catch((e) => {
      // Clear the latch unconditionally, superseded or not: a rejected push
      // may have left the latch describing a preference the native layer
      // never received, and `null` guarantees the next call re-pushes.
      lastPushedPref = null;
      if (seq === pushSeq && retryAttempts < MAX_PUSH_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** retryAttempts;
        retryAttempts++;
        retryHandle = setTimeout(() => {
          retryHandle = null;
          setNativeTheme(pref);
        }, delay);
      }
      console.warn(`[useTauriTheme] set_native_theme("${pref}") failed:`, e);
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
          // Gated on `overrideActive` ONLY -- deliberately not stamped with a
          // `pushSeq` and routed through `acceptReadback`. This fetch and the
          // first `setNativeTheme` push are both microtask-scheduled from the
          // same `createTheme` setup, so a seq captured here is stale before
          // it is compared and the boot reading is discarded every time
          // (measured: a dark-OS boot landed as `null`). The real hazard this
          // needs to avoid is narrower: on macOS `window.theme()` echoes our
          // own force, so skip the seed while an override is live and let
          // `systemTheme` fall through to the honest Rust-provided seed.
          if (overrideActive) return;
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
  let pollImportAttempts = 0;
  const MAX_POLL_IMPORT_ATTEMPTS = 3;
  pollIntervalHandle = setInterval(() => {
    if (!document.hasFocus() || overrideActive) return;
    // Re-acquire `invoke` if the init import failed, so a transient failure
    // doesn't kill the poll for the whole session -- but only a few times.
    // `getInvoke()` clears its cache on rejection, so retrying every tick
    // forever would re-attempt a dynamic import every 3s indefinitely.
    if (!invokeRef) {
      if (pollImportAttempts >= MAX_POLL_IMPORT_ATTEMPTS) return;
      pollImportAttempts++;
      getInvoke()
        .then((invoke) => {
          invokeRef = invoke;
          pollImportAttempts = 0;
        })
        .catch(() => {
          /* already logged by the init path; next tick may retry */
        });
      return;
    }
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
  // call reconciles it.
  const teardown = (): void => {
    stopPoll();
    cancelRetry();
  };
  window.addEventListener("pagehide", teardown, { once: true });
  import.meta.hot?.dispose(teardown);
}
