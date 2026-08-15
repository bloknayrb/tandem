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
 * instead of waiting on the poll below (see `setNativeTheme`).
 *
 * Expressed as a discriminated union rather than a flat struct, because
 * `{ overrideActive: true, osTheme: "dark" }` is exactly the pair that would
 * write an echo of our own force into `tauriTheme.current`. Serde cannot
 * express that from the Rust side's flat struct, but TypeScript is the
 * consumer and is free to be stricter than the producer.
 *
 * Be clear about what this does NOT do. The type reaches values only through
 * `invoke<NativeThemeOutcome>(...)`, an unchecked assertion, so the compiler
 * polices no producer and validates no payload -- the forbidden pair can
 * arrive over the wire and type-check fine. What actually enforces the
 * contract is the `!outcome.overrideActive` guard in `setNativeTheme`'s
 * `.then`, at runtime, where the violation could originate; the union's job is
 * to make that guard the obvious shape and to type `recordResolution`'s
 * parameter. Field-name fidelity against Rust's serde attributes is pinned
 * separately, by `tests/docs/native-theme-claims.test.ts`.
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
// list — a rejection voids the whole of `lastPush` in one expression, and it
// may never write a RESOLUTION into `lastResolved`. (Once the retry ladder is
// exhausted it does drop `lastResolved` to `null` — "we no longer know" is not
// a resolution, and the `.catch` argues why that beats suppressing forever.)
// A NEW pipeline fact belongs as a field on one of them rather than as another
// module `let` — a field is cleared with its record, so `_resetForTests`
// cannot fall out of sync with it.
//
// REQUIRED: both are plain module `let`s and must NEVER become `$state`.
// `setNativeTheme` both reads `lastPush?.pref` and writes `lastPush = {…}`
// synchronously from inside `createTheme`'s `$effect` body
// (useTheme.svelte.ts). A rune would (a) subscribe that effect to the push
// pipeline, re-running `applyTheme` on every settle — precisely the
// accidental subscription the notes in `createTheme` exist to avoid — and
// (b) make that effect self-invalidating, since it both reads `lastPush?.pref`
// and writes `lastPush` in one body: an unbounded re-run surfacing as
// `effect_update_depth_exceeded`. Note it would NOT be `state_unsafe_mutation`
// — that fires only when the active reaction matches `DERIVED | BLOCK_EFFECT |
// ASYNC | EAGER_EFFECT`, and a plain `$effect` is `EFFECT | USER_EFFECT`,
// which matches none of them (verified against the installed runtime; this
// comment previously named the wrong error). Reason (a) carries the
// conclusion on its own. The sibling
// `useTauriFileDrop.svelte.ts` states that it "mirrors `useTauriTheme.svelte.ts`
// in shape" and DOES declare a module-scope `$state`; do not mirror that back
// here. `tauriTheme.current` is the only reactive value in this module.
//
// One cached `invoke` import, reused by both the initial `get_app_theme`
// fetch/poll (in `initTauriTheme`) and every `setNativeTheme` push, instead
// of each site doing its own `import("@tauri-apps/api/core")`.
let invokePromise: Promise<InvokeFn> | null = null;

// The poll interval handle, held here (not just closed over inside
// `initTauriTheme`) so `_resetForTests()` can clear it.
let pollIntervalHandle: ReturnType<typeof setInterval> | null = null;

// The onThemeChanged unlisten handle. A subscription handle, NOT a push-pipeline
// fact — so the "belongs as a field on lastPush/lastResolved" rule above does not
// apply to it. Its sibling is `pollIntervalHandle` directly above: held at module
// scope for exactly the same reason, that `_resetForTests()` must be able to
// release it. Plain `let`, never `$state`, per the REQUIRED note above.
let unlistenTheme: (() => void) | null = null;

// HMR-only latch. Set solely from `import.meta.hot.dispose` — deliberately NOT from
// `teardown`, which is ALSO the `pagehide` handler: `pagehide` fires on bfcache-eligible
// navigations where this module survives and the page can be restored, so latching there
// would poison every later init into unlistening the moment its import resolved. A hot
// reload, by contrast, guarantees a fresh module instance with this back at `false`.
let disposed = false;

/** Release the onThemeChanged subscription, if one was ever stored. */
function releaseThemeListener(): void {
  if (!unlistenTheme) return;
  try {
    unlistenTheme();
  } catch (e) {
    console.warn("[useTauriTheme] onThemeChanged unlisten failed:", e);
  }
  unlistenTheme = null;
}

// The `pagehide` listener registered by `initTauriTheme`, held here for the same
// reason as `unlistenTheme` directly above: `_resetForTests()` and `teardown()`
// both need to remove exactly the listener THIS generation registered, and a
// function-local closure would be unreachable from `_resetForTests()` — the same
// "structurally unobservable" trap the #1413 fix exists to close for
// `onThemeChanged`. Storing only the module-scope handle (never a name a second
// call could shadow) is what makes a later generation unable to remove an
// earlier one's listener by accident.
let pagehideHandler: ((event: PageTransitionEvent) => void) | null = null;

/** Release the `pagehide` listener, if one was ever registered. */
function releasePageHideListener(): void {
  if (!pagehideHandler) return;
  window.removeEventListener("pagehide", pagehideHandler);
  pagehideHandler = null;
}

// Monotonic ticket dispenser, bumped on every `setNativeTheme` call. A push
// compares its own ticket against THIS counter, never against `lastPush`, and
// no `seq` field lives on that record. The durable reason: this counter is
// ALSO the staleness stamp that async read-backs (onThemeChanged, the poll)
// capture at issue time, when `lastPush` may be null — a record-based stamp
// would have nothing to read there. See `acceptReadback` below.
//
// A second reason holds as the `.catch` is currently ordered — `lastPush =
// null` precedes the seq compare, so a record-based compare would read
// `undefined` and the retry would never fire for an unsuperseded push, the one
// case retries exist for. True, but defeated by moving two adjacent
// statements; don't mistake it for the structural argument.
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
// Restoring the previous value is a *guess* that the failed push never landed,
// and a rejection is exactly the state in which we cannot know. Rust names one
// concrete way the guess inverts: `apply_app_mode`'s `recv_timeout` abandons
// the wait without cancelling the queued closure, so the mode can apply a
// moment later (Windows-only, and today unreachable because the closure runs
// inline — but the Rust side bounds the receive anyway, on the grounds that
// the inlining is a Tauri implementation detail). The latch would then claim
// the old preference while the OS holds the new one, and re-picking the old
// one would be deduped away forever. `null` means "no claim", which is the
// only honest state after a failure and guarantees the next push proceeds
// whatever its value.
//
// This is the ONLY dedupe input, and `lastResolved` deliberately carries no
// `pref` field to become a second one. Deduping against the last CONFIRMED
// preference would let a re-pick of it short-circuit past the `cancelRetry()`
// in `setNativeTheme`, leaving an armed retry of a *rejected* push free to
// land later and release an override while the app renders an explicit theme.
// A rejection means "no claim", full stop.
let lastPush: {
  pref: ThemePreference;
  inFlight: boolean;
  issuedAt: number;
  viaRetry: boolean;
} | null = null;

// What the native layer actually DID: the last RESOLVED outcome's
// `overrideActive`. The push pipeline writes it through exactly ONE function,
// `recordResolution` below (plus the initializer and `_resetForTests`), and
// the failure path never records a resolution — a rejected push leaves the
// native override state UNKNOWN, and that is precisely what the client cannot
// guess. Gates read-backs (see `acceptReadback`) so an OS notification
// arriving while an explicit override is forced (macOS only — Windows always
// resolves `false`) isn't mistaken for a real user-driven OS change.
//
// A record rather than the bare boolean it replaced, because the boolean could
// not distinguish "never resolved" from "resolved to `false`" — it initialized
// to the same value it would eventually settle to. `null` is that third state,
// and it is exactly the state #1362 fabricated a false claim about. Every read
// is truthiness today, so the distinction is representable rather than
// consumed; that is deliberate, and it is why a new pipeline fact belongs here
// as a field rather than as another module `let`.
let lastResolved: { overrideActive: boolean } | null = null;

/**
 * The only writer of `lastResolved` in the push pipeline. Taking a whole
 * `NativeThemeOutcome` is the point, not ceremony: the failure path has no
 * outcome in hand, so recording one from there means visibly fabricating an
 * IPC payload rather than assigning a bare `false` — which is what #1362 did.
 * This raises the bar; it does not close the hole.
 */
function recordResolution(outcome: NativeThemeOutcome): void {
  lastResolved = { overrideActive: outcome.overrideActive };
}

// Bounded retry for a rejected push. Without it, a failed *release* would leave
// `lastResolved.overrideActive` true, which suppresses both the poll and every
// `onThemeChanged` — so `tauriTheme.current` would stop moving and the app's
// own `data-theme` would stop following the OS. The ladder is capped so a
// persistently failing invoke cannot hot-loop; PAST the cap the `.catch` drops
// `lastResolved` to `null`, because once we have stopped trying, "unknown" has
// to degrade to "stop suppressing" rather than to "suppress forever".
//
// `retryAttempts` belongs to ONE user intent, not to the session. It is reset
// by `cancelRetry` when a new intent supersedes an armed ladder, and again at
// exhaustion. Without those resets a user toggling themes against a failing
// invoke burns the whole budget in three picks, and every later failure gets
// zero retries — silently.
const MAX_PUSH_RETRIES = 3;
const RETRY_BASE_MS = 500;
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;

/** How often the focused window re-reads the OS theme as a fallback. */
const POLL_INTERVAL_MS = 3000;

// Ceiling on how long an UNSETTLED push may suppress OS read-backs (see
// `acceptReadback`). The bound is not optional: a hung `invoke` never
// rejects, so the retry ladder above is not a release path for it, and
// `inFlight` is otherwise cleared only in the non-superseded `.then` or
// implicitly by `lastPush = null` in the `.catch`. An unbounded gate would
// therefore freeze `tauriTheme.current` for the whole session — exactly the
// failure the retry ladder exists to prevent, reintroduced by the guard.
//
// ONE poll tick is the whole justification, which is why this is defined as
// `POLL_INTERVAL_MS` rather than repeating its number: a hung push costs at
// most one missed re-read, and the next poll re-establishes the OS reading.
//
// An earlier revision cited Rust's `recv_timeout(Duration::from_secs(2))` in
// `apply_app_mode` as the PRIMARY justification. Do not reinstate that: it is
// wrong twice over. `apply_app_mode` is `#[cfg(target_os = "windows")]`, and
// macOS — which routes to `SetWindowTheme` — is the only platform where
// `overrideActive` is ever true, i.e. the only platform this gate exists for.
const PUSH_SETTLE_CEILING_MS = POLL_INTERVAL_MS;

/**
 * Cancels a scheduled push retry, if any, and resets the ladder. Idempotent.
 *
 * The `retryAttempts` reset MUST stay inside the guard. The retry timer clears
 * `retryHandle` BEFORE re-entering `setNativeTheme`, so a call on the retry
 * path sees `null` here and keeps its budget — which is what bounds the
 * ladder. Hoisting the reset out of the guard would make every rung refill its
 * own budget: an unbounded 500 ms hot loop, the exact thing `MAX_PUSH_RETRIES`
 * exists to prevent.
 */
function cancelRetry(): void {
  if (retryHandle !== null) {
    clearTimeout(retryHandle);
    retryHandle = null;
    retryAttempts = 0;
    return;
  }
  // A retry whose timer has already FIRED is not covered by the branch above:
  // the timer nulls `retryHandle` before re-pushing, so between that and the
  // `invoke` settling there is an armed ladder with no handle to find. A new
  // user intent arriving in that window is still a new intent and must get a
  // full budget — otherwise it silently inherits a partly-spent counter and
  // retries fewer times than the next one, with no way to tell from the logs.
  //
  // `viaRetry` is what distinguishes it from the retry's OWN re-entry, which
  // must keep its budget (that call sees `lastPush === null`, because the
  // `.catch` cleared it before arming the timer).
  if (lastPush?.viaRetry) retryAttempts = 0;
}

/** Stops the poll if it is running. Idempotent. */
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
  releaseThemeListener();
  releasePageHideListener();
  // Must be cleared, even though the sibling `useTauriFileDrop._resetForTests` omits the
  // equivalent line: there the omission is inert because HMR never runs under vitest, but
  // any test here that drives the dispose path would otherwise leave this latched and
  // silently turn every subsequent `initTauriTheme` into a no-op subscription.
  disposed = false;
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
 * `onThemeChanged` events and the poll); and `setNativeTheme`'s own
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
 * the poll. NOT used for `setNativeTheme`'s own resolved outcome, which
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
 *    Platform note, the mirror of gate 3's: on Windows there is no echo to
 *    suppress at all (see the platform contract in `setNativeTheme`), so this
 *    gate can only ever discard a GENUINE read-back there. It is kept for
 *    uniformity because the cost is bounded at one poll tick.
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
  if (lastPush?.inFlight && performance.now() - lastPush.issuedAt < PUSH_SETTLE_CEILING_MS) return;
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
 * the Rust side resolves to a no-op *action* (#1363), though the round trip
 * is not itself a no-op -- the outcome still carries an `osTheme`, currently
 * a hardcoded `Light` (see `native_theme_outcome` in `lib.rs`). The client
 * pushes identically on every platform. Called
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
 * declaration for why `null` rather than the previous value. `lastResolved` is
 * NOT touched while retries remain: a failed push means the native override
 * state is UNKNOWN, and leaving read-backs suppressed is stale-but-recoverable
 * where admitting an echo of a force we may not have released is corrupt and
 * self-reinforcing via the poll. Once the ladder is exhausted that trade
 * inverts and it drops to `null`; the `.catch` says why.
 *
 * Note the latch does not prevent duplicate *concurrent* pushes: a stale
 * rejection can clear it while a newer push is still in flight. That is
 * harmless -- the native operation is idempotent -- and the unconditional
 * clear is required, since a superseded rejection must still invalidate the
 * latch. It also reopens `acceptReadback`'s in-flight gate early; that residue
 * is the same benign class the gate narrows rather than closes.
 *
 * Note also that a push which NEVER settles holds the dedupe claim
 * indefinitely: `PUSH_SETTLE_CEILING_MS` bounds only the read-back gate, not
 * the latch. That is unchanged from the pre-#1369 behaviour -- an unsettled
 * push held the latch then too -- so it is not a regression, but the ceiling
 * must not be misread as a general reset.
 */
export function setNativeTheme(pref: ThemePreference): void {
  pushNativeTheme(pref, false);
}

/**
 * The push itself. `viaRetry` exists so `cancelRetry` can tell a retry's own
 * re-entry (keeps its budget) from a new user intent superseding an in-flight
 * retry (gets a fresh one). It is deliberately NOT a parameter on the exported
 * `setNativeTheme`: no caller outside this module can meaningfully supply it,
 * and an optional boolean on the public surface would invite one to try.
 */
function pushNativeTheme(pref: ThemePreference, viaRetry: boolean): void {
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
  // `performance.now()`, not `Date.now()`: `issuedAt` is only ever used to
  // measure an elapsed duration against `PUSH_SETTLE_CEILING_MS`, and the wall
  // clock is not monotonic. An NTP correction or a VM resume that steps the
  // clock backwards while a push is hung makes that difference negative —
  // which is `< PUSH_SETTLE_CEILING_MS` — pinning the read-back gate shut for
  // as long as the offset persists. That is precisely the frozen-theme failure
  // the ceiling exists to guarantee against.
  lastPush = { pref, inFlight: true, issuedAt: performance.now(), viaRetry };
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
      recordResolution(outcome);
      retryAttempts = 0;
      // Authoritative: Rust reads the theme AFTER applying/releasing the
      // override, so on release this is already correct as part of THIS
      // round trip -- no need to wait on a poll tick (acceptReadback above).
      //
      // The `!overrideActive` half enforces `NativeThemeOutcome`'s union at
      // RUNTIME, which is the only place it can be violated: the type is
      // applied via an unchecked `invoke<...>` assertion, and Rust's own
      // struct is flat, so a future edit to `native_theme_outcome`'s match
      // could send the forbidden pair with no error on either side. Writing an
      // `osTheme` read while our force is applied is the #992/#1362 echo bug.
      if (!outcome.overrideActive && outcome.osTheme) setTauriTheme(outcome.osTheme);
    })
    .catch((e) => {
      // Clear the latch unconditionally, superseded or not: a rejected push
      // may have left the latch describing a preference the native layer
      // never received, and `null` guarantees the next call re-pushes. One
      // expression drops the dedupe claim and `inFlight` together.
      lastPush = null;

      // A superseded rejection stops here. The newer push owns the outcome,
      // including whatever `lastResolved` should end up saying.
      if (seq !== pushSeq) {
        console.warn(`[useTauriTheme] set_native_theme("${pref}") failed (superseded):`, e);
        return;
      }

      if (retryAttempts < MAX_PUSH_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** retryAttempts;
        retryAttempts++;
        retryHandle = setTimeout(() => {
          retryHandle = null;
          pushNativeTheme(pref, true);
        }, delay);
        console.warn(
          `[useTauriTheme] set_native_theme("${pref}") failed (retry ${retryAttempts}/${MAX_PUSH_RETRIES}):`,
          e,
        );
        return;
      }

      // Ladder exhausted. Suppressing read-backs was the right trade while a
      // retry was pending — a TRANSIENT unknown resolves in seconds. It
      // inverts once we have stopped trying, and the end states are not
      // symmetric. Keeping `lastResolved.overrideActive` true pins BOTH the
      // poll and every `onThemeChanged` shut with nothing left to reopen them,
      // so the app renders a theme matching neither the OS nor the native
      // surfaces, for the rest of the session, with no self-correction path.
      // Dropping to `null` may instead let a still-forced appearance be read
      // back — wrong against the user's pick, but consistent with the native
      // menus, and it self-corrects the moment any later push succeeds.
      //
      // Note `null`, never `{ overrideActive: false }`: the failure path is
      // still not permitted to invent a resolution. "We no longer know" is a
      // state this type has, which is the whole reason it is nullable.
      lastResolved = null;
      // Give the next intent a fresh ladder; see `retryAttempts`.
      retryAttempts = 0;
      console.warn(
        `[useTauriTheme] set_native_theme("${pref}") gave up after ${MAX_PUSH_RETRIES} retries; OS theme read-backs re-enabled:`,
        e,
      );
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
          // `lastPush.inFlight` either: that first push is normally still
          // unsettled at this moment, so an in-flight gate here would discard
          // the boot reading in the common case, with no offsetting benefit --
          // gate 3 already covers the real (macOS echo) hazard. Pinned by the
          // "seeds the boot theme even though the first push is still
          // unsettled" test; without it this reads as a preference rather
          // than a rule, and adding the gate passed the whole suite.
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

  // Subscribe to onThemeChanged events.
  //
  // Every failure path below is survivable rather than fatal, which is why they warn
  // and return instead of escalating: `systemTheme` falls through to
  // `window.__TANDEM_INITIAL_THEME__` and then to `matchMedia` (useTheme.svelte.ts),
  // so the app still resolves a theme with no Tauri signal at all. What is lost is
  // live OS-flip tracking, and the poll below independently covers that.
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
        .then((unlistenFn) => {
          // HMR fired between `initTauriTheme` and this import resolving: the dispose
          // hook has already run and will not run again for this generation, so release
          // immediately rather than storing a handle nothing will ever clear.
          if (disposed) {
            try {
              unlistenFn();
            } catch (e) {
              console.warn("[useTauriTheme] onThemeChanged unlisten failed:", e);
            }
            return;
          }
          unlistenTheme = unlistenFn;
        })
        .catch((e) => {
          console.warn("[useTauriTheme] onThemeChanged subscribe failed:", e);
        });
    })
    .catch((e) => {
      console.warn("[useTauriTheme] Tauri window API import failed:", e);
    });

  // Polling fallback while focused (POLL_INTERVAL_MS) -- onThemeChanged reliability
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
  //
  // The onThemeChanged subscription is the one thing here that ACCUMULATED across
  // reloads rather than resetting: its unlisten handle was discarded, so each
  // generation left a live listener behind, and every survivor kept writing the
  // process-global `window.__TANDEM_INITIAL_THEME__`. It is now released on dispose
  // along with the poll and the retry (#1413).
  const teardown = (): void => {
    stopPoll();
    cancelRetry();
    releaseThemeListener();
    releasePageHideListener();
  };
  // `event.persisted` means the page is going into the bfcache and can be restored with
  // this module instance intact. Tearing down there would be worse than the leak this
  // change fixes: `_initialized` stays true, so `initTauriTheme` can never re-run, and
  // the restored page would come back with no theme listener and no poll — no path back
  // to an OS signal. Only a real unload releases.
  // Not `{ once: true }`: a persisted hide returns without tearing down, and consuming
  // the listener there would leave the real unload unhandled. Named and stored in
  // `pagehideHandler` (rather than an inline arrow, as an earlier version of this fix
  // had it) so `teardown()` can remove exactly this listener — an unstored listener is
  // the same leak this whole change exists to close, one function below the fix for it:
  // every HMR generation would otherwise register a `pagehide` listener nothing ever
  // removes, on `window`, for the life of the page.
  pagehideHandler = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    teardown();
  };
  window.addEventListener("pagehide", pagehideHandler);
  // `disposed` is latched HERE and only here — see the declaration for why routing it
  // through `teardown` (which `pagehide` also calls) would be wrong.
  import.meta.hot?.dispose(() => {
    disposed = true;
    teardown();
  });
}
