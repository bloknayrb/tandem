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

// ----- Module-scope push/read-back state (#992, restructured in #1369) ----
//
// The push pipeline's own state lives in exactly TWO records below:
// `lastPush` (what we ASSERTED to the native layer) and `lastResolved` (what
// the native layer actually DID). They are split by LIFECYCLE, not by field
// list — a rejection voids the whole of `lastPush` in one expression and must
// never name `lastResolved`. A NEW pipeline fact belongs as a field on one of
// them rather than as another module `let` — a field is cleared with its
// record, so `_resetForTests` cannot fall out of sync with it.
//
// REQUIRED: both are plain module `let`s and must NEVER become `$state`.
// `setNativeTheme` both reads `lastPush?.pref` and writes `lastPush = {…}`
// synchronously from inside `createTheme`'s `$effect` body
// (useTheme.svelte.ts). A rune would (a) subscribe that effect to the push
// pipeline, re-running `applyTheme` on every settle — precisely the
// accidental subscription the notes in `createTheme` exist to avoid — and
// (b) place a `$state` write inside an active reaction, which throws
// `state_unsafe_mutation` in production as well as in dev. The sibling
// `useTauriFileDrop.svelte.ts` states that it "mirrors `useTauriTheme.svelte.ts`
// in shape" and DOES declare a module-scope `$state`; do not mirror that back
// here. `tauriTheme.current` is the only reactive value in this module.
//
// One cached `invoke` import, reused by both the initial `get_app_theme`
// fetch/poll (in `initTauriTheme`) and every `setNativeTheme` push, instead
// of each site doing its own `import("@tauri-apps/api/core")`.
let invokePromise: Promise<InvokeFn> | null = null;

// The 3s poll interval handle, held here (not just closed over inside
// `initTauriTheme`) so `_resetForTests()` can clear it.
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;

// Monotonic ticket dispenser, bumped on every `setNativeTheme` call. A push
// compares its own ticket against THIS counter, never against `lastPush`, and
// no `seq` field lives on that record for two reasons. First, the `.catch`
// sets `lastPush = null` BEFORE the seq compare, so a record-based compare
// would read `undefined` and the retry would never fire for an unsuperseded
// push — the one case retries exist for. Second, this counter is also the
// staleness stamp that async read-backs (onThemeChanged, the poll) capture at
// issue time, when `lastPush` may be null; see `acceptReadback` below.
let pushSeq = 0;

// What we ASSERTED to the native layer: the preference last sent to
// `set_native_theme` (the dedupe latch), whether that push has settled
// (`inFlight`), and when it was issued (`issuedAt` — the bound on how long
// `inFlight` may suppress read-backs). ONE record, so the single expression
// `lastPush = null` on the failure path drops the dedupe claim and reopens
// the read-back gate together; neither can be voided while the other is
// forgotten.
//
// Set OPTIMISTICALLY, before the `invoke` settles, so a rerun while a push is
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
//
// This is the ONLY dedupe input, and `lastResolved` deliberately carries no
// `pref` field to become a second one. Deduping against the last CONFIRMED
// preference would let a re-pick of it short-circuit past the `cancelRetry()`
// in `setNativeTheme`, leaving an armed retry of a *rejected* push free to
// land later and release an override while the app renders an explicit theme
// — the `recv_timeout` hazard described just above. A rejection means "no
// claim", full stop.
let lastPush: { pref: ThemePreference; inFlight: boolean; issuedAt: number } | null = null;

// What the native layer actually DID: the last RESOLVED outcome's
// `overrideActive`. Assigned at exactly ONE site — the non-superseded `.then`
// in `setNativeTheme` — and the failure path never names this variable,
// because a rejected push leaves the native override state UNKNOWN and that
// is precisely what the client cannot guess. Gates read-backs (see
// `acceptReadback`) so an OS notification arriving while an explicit override
// is forced (macOS only — Windows always resolves `false`) isn't mistaken for
// a real user-driven OS change.
//
// It is a record rather than the bare boolean it replaced, and every read is
// truthiness, so the wrapper carries no data the boolean did not. What it
// carries is LEGIBILITY: #1362 was caused by the failure path writing
// `overrideActive = false`, which reads as innocuous cleanup. The equivalent
// write here is `lastResolved = { overrideActive: false }`, which reads as
// inventing a resolution that never happened. The compiler still permits it —
// this raises the bar, it does not close the hole (see the header).
let lastResolved: { overrideActive: boolean } | null = null;

// Bounded retry for a rejected push. Without this, a failed *release* would
// leave `lastResolved.overrideActive` true, which suppresses both the 3s poll
// and every `onThemeChanged` — so `tauriTheme.current` would stop moving and
// the app's own `data-theme` would stop following the OS for the rest of the
// session. Capped and cancelled on supersession so a persistently failing
// invoke cannot hot-loop.
const MAX_PUSH_RETRIES = 3;
const RETRY_BASE_MS = 500;
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;

// Ceiling on how long an UNSETTLED push may suppress OS read-backs (see
// `acceptReadback`). The bound is not optional: a hung `invoke` never
// rejects, so the retry ladder above is not a release path for it, and
// `inFlight` is otherwise cleared only in the non-superseded `.then` or
// implicitly by `lastPush = null` in the `.catch`. An unbounded gate would
// therefore freeze `tauriTheme.current` for the whole session — exactly the
// failure the retry ladder exists to prevent, reintroduced by the guard.
//
// 3000 ms is justified from two independent directions: Rust's own wait in
// `apply_app_mode` is `rx.recv_timeout(Duration::from_secs(2))`, so a healthy
// push settles well inside it; and it matches `POLL_INTERVAL_MS`, so a hung
// push costs at most one poll tick before degrading to the pre-#1369
// behaviour. Deliberately NOT defined as `= POLL_INTERVAL_MS`: the Rust
// timeout is the primary justification and must keep holding if the poll is
// ever retuned. If you change the poll, re-check this comment rather than
// assuming the equality is load-bearing.
const PUSH_SETTLE_CEILING_MS = 3000;

/** How often the focused window re-reads the OS theme as a fallback. */
const POLL_INTERVAL_MS = 3000;

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
  lastPush = null;
  lastResolved = null;
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
 * Three gates, in this order:
 *
 * 1. UNSETTLED PUSH (#1369). `lastResolved` describes the last push to have
 *    RESOLVED, so in the window between an override's appearance flipping and
 *    its `invoke` resolving, gate 3 is still open and gate 2 still passes
 *    (`seqAtIssue === pushSeq`) -- an `onThemeChanged` carrying an echo of our
 *    own force would be written into `tauriTheme.current` as if it were an OS
 *    reading. The window is TIME-BOUNDED because a hung `invoke` neither
 *    resolves nor rejects, and an unbounded gate would freeze
 *    `tauriTheme.current` for the session (see `PUSH_SETTLE_CEILING_MS`).
 *    This gate NARROWS the echo window; it does NOT close it. A stale
 *    rejection clears `lastPush` unconditionally -- by design, see
 *    `setNativeTheme` -- which reopens the gate while a newer push is still
 *    unsettled. That residue is the same benign class the gate reduces.
 *
 * 2. STALENESS. `seqAtIssue` must be the value of `pushSeq` captured when the
 *    read-back was ISSUED (the poll's `invoke` call, or the moment an OS event
 *    was received) -- not when it resolves. A read-back that started before
 *    the latest push began may reflect state from before that push landed, so
 *    it is discarded once a newer push has superseded it.
 *
 * 3. FORCED OVERRIDE. `lastResolved.overrideActive` suppresses read-backs
 *    entirely while an explicit override is forced (macOS only -- Windows
 *    always keeps `overrideActive: false`, so this branch never suppresses
 *    there): any OS-level notification arriving during that window is an echo
 *    of our own force, not a real OS-driven change, and writing it through
 *    would corrupt `tauriTheme.current` with a value the user didn't ask for.
 *    A never-yet-resolved `lastResolved` is `null`, which is falsy exactly
 *    like the `false` this used to initialize to.
 */
function acceptReadback(seqAtIssue: number, next: "light" | "dark"): void {
  if (lastPush?.inFlight && Date.now() - lastPush.issuedAt < PUSH_SETTLE_CEILING_MS) return;
  if (seqAtIssue !== pushSeq) return; // issued before the latest push -- stale
  if (lastResolved?.overrideActive) return; // echo of our own force (macOS only)
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
 * `lastPush.pref` dedupes so the effect this feeds (`createTheme`'s merged
 * `$effect`, which also reruns on `lightVariant` churn) doesn't re-push an
 * unchanged preference. It is set OPTIMISTICALLY, before the `invoke`
 * settles, and the whole record is cleared to `null` on rejection -- see its
 * declaration for why `null` rather than the previous value. `lastResolved`
 * is deliberately NOT touched on rejection: a failed push means the native
 * override state is UNKNOWN, and leaving read-backs suppressed is
 * stale-but-recoverable, where admitting an echo of a force we may not have
 * released is corrupt and self-reinforcing via the poll.
 *
 * Note the latch does not prevent duplicate *concurrent* pushes: a stale
 * rejection can clear it while a newer push is still in flight. That is
 * harmless -- the native operation is idempotent. Since #1369 that same clear
 * also reopens `acceptReadback`'s in-flight gate, so a stale rejection can
 * admit an OS read-back while a newer push is still unsettled; that residue
 * is the same benign class the gate narrows rather than closes, and the
 * unconditional clear is required (a superseded rejection must still
 * invalidate the latch).
 *
 * Note also that a push which NEVER settles holds the dedupe claim
 * indefinitely: `PUSH_SETTLE_CEILING_MS` bounds only the read-back gate, not
 * the latch. That is unchanged from the pre-#1369 behaviour -- an unsettled
 * push held the latch then too -- so it is not a regression, but the ceiling
 * must not be misread as a general reset.
 */
export function setNativeTheme(pref: ThemePreference): void {
  if (!isTauriRuntime()) return;
  // Cancel BEFORE the dedupe check, not after. A new intent supersedes a
  // pending retry whether or not it needs an `invoke`. Today this is a
  // provable no-op in the deduped case, because an armed retry implies
  // `lastPush === null` (retries are armed only in the `.catch`, which nulls
  // it, and only when `seq === pushSeq`) — so a deduped call cannot have one
  // pending. That invariant is exactly what #1369 proposed to break by
  // widening the dedupe input to a last-RESOLVED preference: the re-picked
  // pref would short-circuit past this line and leave a rejected push's retry
  // armed to release the override under an explicit theme. Hoisting it costs
  // nothing and makes the ordering safe independently of that reasoning.
  cancelRetry();
  if (pref === lastPush?.pref) return;
  const seq = ++pushSeq;
  lastPush = { pref, inFlight: true, issuedAt: Date.now() };
  getInvoke()
    .then((invoke) => invoke<NativeThemeOutcome>("set_native_theme", { theme: pref }))
    .then((outcome) => {
      if (seq !== pushSeq) return; // superseded by a later push -- discard
      // MUTATE, never reassign, and the `if` guard is not defensive noise: it
      // is the case where a concurrent stale rejection voided the claim. The
      // reassigning form would not be *wrong* here -- this push is current
      // (`seq === pushSeq`) and it succeeded -- but mutating keeps "a
      // rejection voids the claim, and nothing undoes that" a ONE-WAY
      // invariant with a single writer per direction. That is what makes the
      // `.catch` below readable as the whole failure story.
      if (lastPush) lastPush.inFlight = false;
      lastResolved = { overrideActive: outcome.overrideActive };
      retryAttempts = 0;
      // Authoritative: Rust reads the theme AFTER applying/releasing the
      // override, so on release this is already correct as part of THIS
      // round trip -- no need to wait on the 3s poll (acceptReadback above).
      if (outcome.osTheme) setTauriTheme(outcome.osTheme);
    })
    .catch((e) => {
      // Clear the latch unconditionally, superseded or not: a rejected push
      // may have left the latch describing a preference the native layer
      // never received, and `null` guarantees the next call re-pushes. This
      // one expression is the whole of the PIPELINE state change on failure:
      // it drops the dedupe claim and `inFlight` together, and `lastResolved`
      // is deliberately never named here. (The retry bookkeeping below is
      // scheduling, not pipeline state.)
      lastPush = null;
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
          // Gated on `lastResolved.overrideActive` ONLY -- deliberately not
          // stamped with a `pushSeq` and routed through `acceptReadback`.
          // This fetch and the
          // first `setNativeTheme` push are both microtask-scheduled from the
          // same `createTheme` setup, so a seq captured here is stale before
          // it is compared and the boot reading is discarded every time
          // (measured: a dark-OS boot landed as `null`). The real hazard this
          // needs to avoid is narrower: on macOS `window.theme()` echoes our
          // own force, so skip the seed while an override is live and let
          // `systemTheme` fall through to the honest Rust-provided seed.
          //
          // For the same reason this is deliberately NOT gated on
          // `lastPush.inFlight` either: that first push is unsettled at
          // exactly this moment by construction, so an in-flight gate here
          // would discard the boot reading every single time.
          if (lastResolved?.overrideActive) return;
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
  // discarded by acceptReadback's `lastResolved.overrideActive` check, so
  // there's no reason to make the IPC call at all.
  //
  // Deliberately NOT skipped merely because a push is unsettled. A forced
  // override is a durable state worth short-circuiting; the in-flight window
  // is milliseconds, so a skip keyed on it would be a race rather than a
  // rule, and `acceptReadback` already discards anything that lands inside
  // it.
  let pollErrorLogged = false;
  let pollImportAttempts = 0;
  const MAX_POLL_IMPORT_ATTEMPTS = 3;
  pollIntervalHandle = setInterval(() => {
    if (!document.hasFocus() || lastResolved?.overrideActive) return;
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
  }, POLL_INTERVAL_MS);

  // Clean up the polling interval. pagehide is more reliable than unload in
  // Chromium-based environments (including Tauri's WebView2).
  //
  // HMR dispose is a DEV-MODE WART, not app teardown -- Vite re-evaluates
  // this module on hot-reload, which resets in-memory state (`lastPush`,
  // `lastResolved`, `pushSeq` all go back to their
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
