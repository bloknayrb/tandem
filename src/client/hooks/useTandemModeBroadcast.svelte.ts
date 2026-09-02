import * as Y from "yjs";
import { API_MODE_RELEASE } from "../../shared/api-paths.js";
import {
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withBrowser } from "../../shared/origins.js";
import type { TandemMode } from "../../shared/types.js";
import { TandemModeSchema } from "../../shared/types.js";
import { logClientWarning } from "../utils/client-log.js";
import { API_BASE } from "../utils/fileUpload.js";

/**
 * WS-A2: on a Solo→Tandem flip, tell the server to RELEASE what was held —
 * flip mode server-side, clear the persisted held markers, and wake the push
 * monitor once. The held items themselves reach Claude via the checkInbox /
 * getAnnotations pull path (which re-reads live mode), so this POST is a
 * best-effort proactive nudge, NOT the delivery mechanism: if it fails, the
 * items still surface on Claude's next inbox poll. One retry covers a transient
 * blip; the badge remains the honesty backstop (it clears from the server's
 * marker-clear, never from the mode flip alone).
 */
async function triggerSoloRelease(attempt = 0): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}${API_MODE_RELEASE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok && attempt === 0) {
      console.warn(`[tandem] mode-release POST returned ${res.status}; retrying once`);
      return triggerSoloRelease(1);
    }
  } catch (err) {
    if (attempt === 0) {
      console.warn("[tandem] mode-release POST failed; retrying once:", err);
      return triggerSoloRelease(1);
    }
    console.warn("[tandem] mode-release POST failed after retry:", err);
  }
}

/**
 * WS-A2: the Solo→Tandem release fires ONLY on that exact transition. Edge-detect
 * so a tandem→tandem no-op, the initial set, or a tandem→solo flip (entering
 * Solo) never triggers a release. Pure so it can be unit-tested without the
 * rune-backed hook. Exported for `tests/client/tandem-mode-release-trigger`.
 */
export function shouldReleaseSolo(prev: TandemMode, next: TandemMode): boolean {
  return prev === "solo" && next === "tandem";
}

export interface TandemModeBroadcastState {
  readonly tandemMode: TandemMode;
  setTandemMode: (mode: TandemMode) => void;
}

/**
 * Svelte 5 port of `useTandemModeBroadcast`.
 *
 * Manages tandem mode state: persists to localStorage, and broadcasts both
 * `Y_MAP_MODE` and `Y_MAP_DWELL_MS` to the CTRL_ROOM Y.Map so the server
 * (and Claude) can see the current settings.
 *
 * Accepts getter functions for reactive inputs.
 */
export function createTandemModeBroadcast(
  getBootstrapYdoc: () => Y.Doc | null,
  getSelectionDwellMs: () => number,
  /**
   * True once the CTRL provider has completed its first authoritative sync
   * (`yjsSync.ctrlInitialSyncComplete`). Gates the broadcasts below — see #1621.
   *
   * REQUIRED, deliberately. A default of `() => true` would be the pre-#1621
   * behaviour exactly — broadcast into an unsynced doc, concurrent with the
   * incumbent, clientID coin flip — so an omitted argument would revert the fix
   * silently and typecheck. Review found that every spec in
   * `tests/client/tandem-mode-race.test.ts` stays green under that revert,
   * because they drive the hook through a fixture that passes its own getters.
   * Requiring it makes the revert a compile error instead. The remaining hole,
   * passing a `const` snapshot rather than a live getter, is pinned statically by
   * `tests/client/tandem-mode-wiring.test.ts`.
   */
  getCtrlSynced: () => boolean,
): TandemModeBroadcastState {
  let tandemMode = $state<TandemMode>(
    (() => {
      try {
        const saved = localStorage.getItem(TANDEM_MODE_KEY);
        const parsed = TandemModeSchema.safeParse(saved);
        if (parsed.success) return parsed.data;
      } catch (err) {
        console.warn(`[tandem] localStorage unavailable reading ${TANDEM_MODE_KEY}:`, err);
        return TANDEM_MODE_DEFAULT;
      }
      // #1623: the user's last mode IS the preference — there is no separate
      // configured default. Settings → Collaboration used to carry one, stored
      // and validated and migrated and read by nothing; rather than wire it up,
      // it was removed, because persisting the toggle already expresses the same
      // intent and two sources for one preference can disagree.
      return TANDEM_MODE_DEFAULT;
    })(),
  );

  /**
   * #1621: the mode this client last wrote into the room, or null if it has not
   * written to the current ctrl doc yet.
   *
   * A PLAIN variable, deliberately not `$state` — and the reason is narrower
   * than an earlier version of this comment claimed, in a way that matters to
   * anyone editing the observer.
   *
   * The hazard is real in general: Svelte bills a signal read to whatever
   * reaction is active, the Y.Map observer below runs synchronously inside the
   * broadcast effect's own `withBrowser` transaction, and a rune read there
   * would add itself to the BROADCAST effect's dependency set — which, since
   * that effect also writes it, is a self-invalidation. It was measured, on an
   * earlier design that mirrored the room value into a rune and read it on that
   * path: the broadcast re-ran on every remote change and re-stamped its own
   * value before anything else could see the arriving one.
   *
   * It is NOT reachable in the code as it now stands, and the guard ORDER is the
   * only thing keeping it that way. `if (transaction.local) return` bails before
   * the first read of `lastBroadcast`, so the local re-entrant path — the one
   * with an active reaction — never reads it; the remote path runs from the
   * provider's socket handler, where no reaction is active. Moving that read
   * above the `local` guard resurrects the measured behaviour. So a rune here
   * would buy nothing and add a signal, and a future reader must not "restore"
   * one on the grounds that the danger is hypothetical.
   *
   * Null also gates the detector: before this client has written, the room
   * legitimately holds the previous session's persisted mode (`restoreCtrlDoc`),
   * so comparing then would warn on every launch.
   */
  let lastBroadcast: TandemMode | null = null;

  // Persist tandem mode to localStorage
  $effect(() => {
    const mode = tandemMode;
    try {
      localStorage.setItem(TANDEM_MODE_KEY, mode);
    } catch (err) {
      console.warn(`[tandem] failed to persist ${TANDEM_MODE_KEY}:`, err);
    }
  });

  // Broadcast tandem mode to CTRL_ROOM Y.Map.
  //
  // #1621: GATED ON CTRL SYNC, and that gate is the fix. `bootstrapYdoc` is
  // published at provider construction, before any server state has arrived, so
  // writing on the bare non-null transition made this write CONCURRENT with
  // whatever the server already held. Yjs breaks a concurrent Y.Map tie by
  // highest clientID, not recency, and clientIDs are random per launch — so
  // every startup was a coin flip, silently, because nothing read the key back.
  // Writing after sync makes THIS LAUNCH'S write causally after the incumbent it
  // has already received, so it wins regardless of clientID. Measured both
  // orderings; see the tie-break spec. The server-side half of that ordering is
  // load-bearing and lives elsewhere: `restoreCtrlSession()` runs before
  // `startHocuspocus()` in `src/server/index.ts`, so the WS port is not bound
  // when the restore's blind `applyUpdate` lands and no client can have written
  // first.
  //
  // It does NOT close the class, and the comment used to imply it did. Four
  // concurrent cases remain, none of them regressions: the key absent entirely
  // (fresh install, or a lost ctrl session file — every writer then has a null
  // left origin); two already-synced clients toggling at once; `/api/mode/release`
  // racing a client toggle; and a toggle made during a network blip, since
  // `ctrlInitialSyncComplete` latches and is cleared only on doc replacement,
  // never on a plain disconnect. The read-back below is what makes those audible.
  //
  // Both getters are read UNCONDITIONALLY before the early return: Svelte 5
  // recomputes an effect's dependency set on every run, so a getter skipped by
  // an early return is not tracked and the effect would not re-run when the
  // flag flips.
  $effect(() => {
    const bootstrapYdoc = getBootstrapYdoc();
    const synced = getCtrlSynced();
    const mode = tandemMode;
    // Clearing here is what stops the detector comparing the NEW room's restored
    // value against a write that only happened on the previous generation's doc.
    //
    // The two halves are NOT interchangeable, though an earlier comment here said
    // so. `bootstrapCleanup` and `startBootstrap` run synchronously within one
    // call, so Svelte never observes the intermediate `(null, false)` state and
    // the effect flushes once against the final `(newDoc, false)` — where
    // `!bootstrapYdoc` is already false. So `!synced` is what covers a doc swap;
    // `!bootstrapYdoc` covers only pre-bootstrap and post-`destroy()`. A
    // doc-identity check was here too and was removed: no reachable scenario
    // could distinguish it, because `startBootstrap` sets
    // `ctrlInitialSyncComplete = false` before publishing the new doc and only an
    // async `provider.on("synced")` sets it true.
    if (!bootstrapYdoc || !synced) {
      lastBroadcast = null;
      return;
    }
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      withBrowser(bootstrapYdoc, () => awareness.set(Y_MAP_MODE, mode));
      lastBroadcast = mode;
    } catch (err) {
      console.warn("[tandem] failed to broadcast tandem mode to Y.Map:", err);
    }
  });

  // #1621 part 2: read the key BACK, and report a disagreement.
  //
  // Part 1 fixes today's race. This is what stops the NEXT one being silent —
  // the broadcast was write-only, which is the whole reason a lost CRDT tie went
  // unnoticed through a shipped release. Two cases part 1 does not close and
  // this does report: two editors with different stored modes (the Tauri WebView
  // and a browser tab have separate localStorage), and `/api/mode/release`
  // writing "tandem" unconditionally over a second client sitting in Solo.
  //
  // It DOES NOT adopt the room's value, and that is a decision rather than a
  // simplification. Adopting would let another window — or the server's own
  // release route — take the user out of Solo without them touching anything,
  // and Solo is a privacy control whose toggle promises Claude will not see
  // their comments. A mechanism added to make that promise honest must not be
  // able to revoke it.
  //
  // The asymmetry was considered, not overlooked. The mirror case — we hold
  // "solo" and the room holds "tandem" — is the one that actually breaks Solo's
  // promise, and re-asserting our own value there WOULD win, because our write
  // would be causally after the competitor's item. It is not done here because
  // two clients that both re-assert never converge, and bounding that needs its
  // own design. Warn-only is the half that cannot make things worse.
  //
  // Registered on the Yjs observer rather than in an `$effect` over a mirrored
  // rune: the mirror is what coupled the two effects in the first place (see
  // `lastBroadcast`). Nothing here reads or writes reactive state, so there is
  // no ordering question and no `state_unsafe_mutation` exposure.
  $effect(() => {
    const bootstrapYdoc = getBootstrapYdoc();
    if (!bootstrapYdoc) return;
    const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
    const observer = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
      // `local` is the discriminator, not an equality check on the value. Our
      // own `awareness.set` re-enters this observer synchronously inside the
      // broadcast effect's transaction with `local === true`; only an update the
      // provider applied from the wire can carry a competing writer's value.
      if (transaction.local) return;
      if (!event.keysChanged.has(Y_MAP_MODE)) return;
      if (lastBroadcast === null) return;
      const parsed = TandemModeSchema.safeParse(awareness.get(Y_MAP_MODE));
      if (!parsed.success || parsed.data === lastBroadcast) return;
      // `logClientWarning`, never a bare `console.warn` (#1439): the release
      // desktop build ships no devtools feature, so a console line there is
      // written to a sink nobody can read. This lands in Copy Diagnostics and
      // the prefilled bug report instead. The event is two static literals
      // rather than an interpolated pair because `scope`/`event` must be
      // literals — that is the privacy control, pinned by
      // `tests/client/client-log-callsites.test.ts`.
      if (parsed.data === "solo") {
        logClientWarning("tandem-mode", "room-holds-solo-not-ours");
      } else {
        logClientWarning("tandem-mode", "room-holds-tandem-not-ours");
      }
    };
    awareness.observe(observer);
    return () => {
      awareness.unobserve(observer);
    };
  });

  // Broadcast selection dwell time to CTRL_ROOM. Same race, same gate — this
  // write is concurrent in exactly the way the mode write was.
  //
  // Same race, but deliberately NO detector, which is a decision and not an
  // omission. Its source is a per-client settings slider, so two windows with
  // different values genuinely disagree forever with no resolution: a read-back
  // here would warn continuously and train everyone to ignore the diagnostics
  // buffer, which is the failure this file argues against elsewhere. The mode
  // key is different because both windows are claiming the same global fact.
  // `tests/shared/mode-writer-set.test.ts` pins this key's writer set too, while
  // the answer is still "one".
  $effect(() => {
    const bootstrapYdoc = getBootstrapYdoc();
    const synced = getCtrlSynced();
    const dwellMs = getSelectionDwellMs();
    if (!bootstrapYdoc || !synced) return;
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      withBrowser(bootstrapYdoc, () => awareness.set(Y_MAP_DWELL_MS, dwellMs));
    } catch (err) {
      console.warn("[tandem] failed to broadcast dwell ms to Y.Map:", err);
    }
  });

  return {
    get tandemMode() {
      return tandemMode;
    },
    setTandemMode(mode: TandemMode) {
      const prev = tandemMode;
      tandemMode = mode;
      // WS-A2: leaving Solo releases everything held while in Solo.
      if (shouldReleaseSolo(prev, mode)) {
        void triggerSoloRelease();
      }
    },
  };
}
