/**
 * The local period (#1123, part A2: Claude's side; ADR-039's amendment of
 * 2026-11-13). While Tandem chat is answered by a local model, Claude is
 * handed nothing at all (Bryan's decision 1, "Nothing goes to Claude"), and
 * what the user typed meanwhile is never handed to it afterwards (decision 3,
 * "Never hand them over").
 *
 * **The local period** runs from the moment `chatAnswerer()`, once primed,
 * reads the local model until it reads Claude again. A restart in the middle
 * does not start a new one: whether one is open is persisted.
 *
 * **Two guards, and only this module reads either** (the brief's dark
 * requirement):
 *  - {@link inLocalPeriod} — "in the local period now" — reads `chatAnswerer()`,
 *    which answers Claude until it is primed, and it is primed only under
 *    `BYO_MODELS_ENABLED`. It gates what is decided live: the inbox blanking,
 *    the live push gate and refusing every replay, the wake advisory, the
 *    supervisor's holds and the round suspension.
 *  - {@link honourLocalPeriodRecords} — "honour local-period records" — reads
 *    the flag, never A1's primed state (priming sits in its own `try` and can
 *    fail). It gates everything recorded: classing chat, the per-event replay
 *    verdict, excluding local-period chat and local-model activity on every
 *    path, and the selection hold. It keeps working while `chatAnswerer()`
 *    reads Claude.
 *
 * **What is kept, and where.** Each chat row is classed ONCE, by the server,
 * when it first sees the row's `add` (before any origin skip, whatever its
 * author), from what `chatAnswerer()` reads at that moment; nothing re-classes
 * it, and a row's identity is its map key, so a server write that rewrites a
 * row (a `read`/`delivered` stamp, `localRun`, a restore) or a client edit of
 * its fields never changes its class, and a row deleted and re-added under the
 * same key keeps it. Classes, whether a local period is open, and the
 * owed-at-switch set are kept with the CTRL session's own durable state —
 * the `localPeriod` field beside `ydocState` in the CTRL session file, written
 * by the server only, inside the queued snapshot step, so a chat row and its
 * class are saved and lost together. Only classes of rows the snapshot keeps
 * are written, and only `true` ones (a row with no class is not local-period
 * chat). That file is the user's own app data, owner-only like every session
 * file; it holds message ids, never text.
 *
 * **The bound.** In memory: a class for every row the CTRL chat map holds,
 * plus at most {@link DELETED_CLASS_CAP} classes of deleted rows (oldest
 * first out), kept so a same-key re-add keeps its class within a run. On
 * disk: only rows still in the pruned (200-row) snapshot.
 */

import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import type { TandemEvent } from "../events/types.js";
import {
  type ChatAnswererSwitchSource,
  chatAnswerer,
  chatAnswererPrimed,
  onChatAnswererChanged,
} from "./chat-answerer.js";

// --- The two guards ---------------------------------------------------------

let honourOverrideForTests: boolean | null = null;

/** Guard 2: honour local-period records. The flag, never the primed state. */
export function honourLocalPeriodRecords(): boolean {
  return honourOverrideForTests ?? BYO_MODELS_ENABLED;
}

/** Guard 1: in the local period now. Claude until primed (the dark guard). */
export function inLocalPeriod(): boolean {
  return chatAnswerer() === "local";
}

// --- Chat classes -----------------------------------------------------------

/** How many classes of DELETED rows are kept in memory (the bound). */
export const DELETED_CLASS_CAP = 1_000;

/** Row key → is it local-period chat. Insertion order is classing order. */
const classes = new Map<string, boolean>();
/** Deleted keys whose class is kept, oldest first. */
const deletedKeys = new Set<string>();

/**
 * Class a chat row the server sees added. Called by the CTRL chat observer for
 * every `add`, before its origin skip, whatever the author. A key already
 * classed keeps its class (the same-key re-add rule), and its delete record is
 * dropped since the row exists again.
 */
export function classChatRowAdded(key: string): void {
  if (!honourLocalPeriodRecords()) return;
  if (classes.has(key)) {
    deletedKeys.delete(key);
    return;
  }
  classes.set(key, inLocalPeriod());
}

/** A chat row was deleted (by anyone). Its class is kept, within the bound. */
export function noteChatRowDeleted(key: string): void {
  if (!classes.has(key)) return;
  deletedKeys.delete(key);
  deletedKeys.add(key);
  while (deletedKeys.size > DELETED_CLASS_CAP) {
    const oldest = deletedKeys.values().next().value as string;
    deletedKeys.delete(oldest);
    classes.delete(oldest);
  }
}

/** The user cleared chat (`clearCtrlChatDurably`): the cleared rows and their
 *  classes go together, so a same-key re-add afterwards is a new row. */
export function forgetChatRows(keys: Iterable<string>): void {
  for (const key of keys) {
    classes.delete(key);
    deletedKeys.delete(key);
    // A same-key re-add after Clear chat is a new row: never "sent before
    // the switch" (review item 19).
    owedAtSwitch.delete(key);
  }
}

/** Is this row local-period chat? Guard 2. A row with no class is not. */
export function isLocalPeriodChat(key: string): boolean {
  return honourLocalPeriodRecords() && classes.get(key) === true;
}

// --- Events withheld for the local period ------------------------------------

/**
 * Events an observer marked as local-model activity or as a push of
 * local-period chat (a same-key re-add, R3.4b), decided where the record is
 * read. A side table, because `TandemEvent` is the SSE wire shape.
 */
let markedEvents = new WeakSet<TandemEvent>();

/** Mark an event that must never reach an external consumer (guard 2). */
export function markWithheldForLocalPeriod(event: TandemEvent): void {
  if (honourLocalPeriodRecords()) markedEvents.add(event);
}

/**
 * The push-time verdict (R3.1, R3.2, R3.4): is this event withheld from every
 * external consumer? Decided ONCE per event by `pushEvent`, recorded there,
 * and never re-decided by a replay. Separate from the licence decision, which
 * it never replaces or reorders.
 */
export function withheldForLocalPeriod(event: TandemEvent): boolean {
  if (!honourLocalPeriodRecords()) return false;
  return inLocalPeriod() || markedEvents.has(event);
}

/** Is a record local-model activity? Its `agentIdentity` stamp is the only
 *  mark (every production local-model write carries it). */
export function isLocalModelRecord(record: unknown): boolean {
  if (!honourLocalPeriodRecords()) return false;
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { agentIdentity?: unknown }).agentIdentity !== undefined
  );
}

// --- The owed-at-switch set and the open marker -----------------------------

let open = false;
let owedAtSwitch = new Set<string>();

/** Was this chat row owed to Claude when the last local period began? The
 *  R2.4 sentence goes with such a row whenever it is handed afterwards. */
export function wasOwedAtSwitch(key: string): boolean {
  return honourLocalPeriodRecords() && owedAtSwitch.has(key);
}

// --- Decision 11's selection hold --------------------------------------------

/** Sentinel for "the selection record carried no numeric stamp". */
const NO_STAMP = -1;
/** Document id → the selection stamp recorded at the switch back or at boot. */
const heldSelections = new Map<string, number>();

function stampOf(stamp: unknown): number {
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : NO_STAMP;
}

/** Record a document's current selection stamp. */
export function recordHeldSelection(documentId: string, stamp: unknown): void {
  heldSelections.set(documentId, stampOf(stamp));
}

/**
 * May this selection be handed (in `activity`, or on a push)? Guard 1 decides
 * "none during the local period"; the stamp comparison is guard 2's: a
 * selection is handed only when its stamp differs from the one recorded for
 * its document (a document with no record is compared against nothing and
 * handed — decision 11's accepted gap for a session restored later).
 */
export function selectionMayBeHanded(documentId: string, stamp: unknown): boolean {
  // No "none during the local period" arm here: during the period the inbox
  // is blank and every push is withheld from external consumers by the
  // per-event verdict, so a selection reaches only in-process subscribers —
  // the local model, which answers that chat and should see it. The switch
  // back drops the buffer (review item 26).
  if (!honourLocalPeriodRecords()) return true;
  const held = heldSelections.get(documentId);
  return held === undefined || held !== stampOf(stamp);
}

// --- Switch handling ------------------------------------------------------------

/** What the supervisor is told (`launcher/supervisor.ts`'s `localPeriod` seam). */
export type LocalPeriodChange = { to: "local" } | { to: "claude"; asked: boolean };

/** What the switch needs from layers this module must not import. */
export interface LocalPeriodHooks {
  /** User chat rows not classed local that no Claude row answers. */
  unansweredUserChat: () => string[];
  /** Every row key the CTRL chat map holds now. */
  chatKeys: () => string[];
  /** Every open document's current selection stamp. */
  currentSelections: () => Array<{ documentId: string; stamp: unknown }>;
  suspendDeliveryRound: () => void;
  /** Drop every buffered selection (made during the local period). */
  clearBufferedSelections: () => void;
  discardSuspendedRound: () => void;
  /** The R5.2 wake, through the normal push path. */
  emitReturnWake: () => void;
  /** Write the CTRL snapshot through the queued path. */
  persist: () => void;
}

let hooks: LocalPeriodHooks | null = null;
let unsubscribeSwitch: (() => void) | null = null;
const supervisorListeners = new Set<(change: LocalPeriodChange) => void>();

/** The supervisor's subscription. Returns the unsubscribe. */
export function subscribeLocalPeriod(cb: (change: LocalPeriodChange) => void): () => void {
  supervisorListeners.add(cb);
  return () => {
    supervisorListeners.delete(cb);
  };
}

function tellSupervisor(change: LocalPeriodChange): void {
  for (const cb of [...supervisorListeners]) {
    try {
      cb(change);
    } catch (err) {
      console.error("[Tandem] A local-period listener failed:", err);
    }
  }
}

function recordAllSelections(h: LocalPeriodHooks): void {
  for (const { documentId, stamp } of h.currentSelections()) recordHeldSelection(documentId, stamp);
}

function beginPeriod(h: LocalPeriodHooks): void {
  // A new local period replaces the set (the ruling): a period-1 chat is never
  // marked again after period 2. Emptied BEFORE it is taken, so a read that
  // throws leaves no earlier period's set behind (review item 17).
  owedAtSwitch = new Set();
  open = true;
  step("owed-at-switch", () => {
    owedAtSwitch = new Set(h.unansweredUserChat());
  });
}

/** Run one switch step on its own, so a step that throws (a document closing
 *  mid-read, say) never skips the steps after it. */
function step(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[Tandem] The local period's ${label} step failed:`, err);
  }
}

function onSwitch(now: "claude" | "local", source: ChatAnswererSwitchSource): void {
  const h = hooks;
  if (!h) return;
  if (now === "local") {
    beginPeriod(h);
    step("round", () => h.suspendDeliveryRound());
    step("supervisor", () => tellSupervisor({ to: "local" }));
    step("persist", () => h.persist());
    return;
  }
  open = false;
  // The user's switch back is a switch to Claude made in Tandem's own window;
  // every other is unasked (the brief's Terms).
  const asked = source === "own-window";
  // The buffer first: a selection made during the period must never ride a
  // later push, even if recording the stamps below fails.
  step("selection buffer", () => h.clearBufferedSelections());
  step("selection hold", () => recordAllSelections(h));
  step("round", () => h.discardSuspendedRound());
  step("supervisor", () => tellSupervisor({ to: "claude", asked }));
  if (asked) step("wake", () => h.emitReturnWake());
  step("persist", () => h.persist());
}

/**
 * Wire the switch. Called once from `index.ts` with the hooks; idempotent.
 * The listener is synchronous: the owed-at-switch set is taken in the same
 * stretch as the switch (the ruling).
 */
export function installLocalPeriod(h: LocalPeriodHooks): void {
  hooks = h;
  unsubscribeSwitch ??= onChatAnswererChanged(onSwitch);
}

/**
 * At boot, after `primeChatAnswerer` (so after the CTRL restore and the open
 * documents' restore) and before Hocuspocus binds or the supervisor starts.
 * A boot that reads the local model sets up the same holds as a switch to it;
 * one that reads Claude with a period still open closes it (an unasked switch
 * back while Tandem was down: nothing is woken, and the supervisor boots as
 * its start mode says, decision 10). With the flag on, every open document's
 * selection stamp is recorded, whether or not a local period ever happened.
 */
export function bootLocalPeriod(): void {
  const h = hooks;
  if (!h || !honourLocalPeriodRecords()) return;
  // Every row restored from the CTRL file and not recorded as local-period
  // chat is classed now as not local-period chat, so a same-key re-add of
  // one keeps that class rather than being classed afresh.
  step("restored classes", () => {
    for (const key of h.chatKeys()) if (!classes.has(key)) classes.set(key, false);
  });
  let changed = false;
  if (!chatAnswererPrimed()) {
    // Priming failed: who answers chat is unknown to this run, so a persisted
    // period is neither closed nor begun (guard 2's work below still runs).
  } else if (inLocalPeriod()) {
    if (!open) {
      beginPeriod(h);
      changed = true;
    }
  } else if (open) {
    open = false;
    changed = true;
  }
  step("selection hold", () => recordAllSelections(h));
  if (changed) step("persist", () => h.persist());
}

/**
 * Decision 11's boot record point, taken again immediately before Hocuspocus
 * binds, once every startup document (CHANGELOG, `TANDEM_OPEN_FILE`,
 * welcome) is open (review item 21). Guard 2.
 */
export function recordBootSelections(): void {
  const h = hooks;
  if (!h || !honourLocalPeriodRecords()) return;
  step("selection hold", () => recordAllSelections(h));
}

// --- Persistence (the CTRL session file's `localPeriod` field) ----------------

/** The persisted shape. Versioned; anything else is ignored. */
export interface LocalPeriodRecord {
  v: 1;
  open: boolean;
  owed: string[];
  local: string[];
}

/** Read the field from a CTRL session file, before its rows are restored. A
 *  dark build never calls this, and ignores the field. */
export function loadLocalPeriodRecord(raw: unknown): void {
  if (!honourLocalPeriodRecords()) return;
  if (typeof raw !== "object" || raw === null) return;
  const r = raw as Partial<LocalPeriodRecord>;
  if (r.v !== 1) return;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  open = r.open === true;
  owedAtSwitch = new Set(strings(r.owed));
  for (const key of strings(r.local)) classes.set(key, true);
}

/**
 * The field to write beside a snapshot whose chat map retains `retained`.
 * Undefined (nothing written) with the flag off, so a dark build's CTRL file
 * is byte-identical to master's. Captured inside the queued snapshot step.
 */
export function localPeriodRecordFor(retained: ReadonlySet<string>): LocalPeriodRecord | undefined {
  if (!honourLocalPeriodRecords()) return undefined;
  const local: string[] = [];
  for (const [key, isLocal] of classes) if (isLocal && retained.has(key)) local.push(key);
  return {
    v: 1,
    open,
    owed: [...owedAtSwitch].filter((key) => retained.has(key)),
    local,
  };
}

// --- Test seams -----------------------------------------------------------------

/** Turn guard 2 on or off for a test (production reads the literal flag). */
export function __setHonourLocalPeriodRecordsForTests(on: boolean | null): void {
  honourOverrideForTests = on;
}

/** Forget everything, the switch listener included. */
export function __resetLocalPeriodForTests(): void {
  classes.clear();
  deletedKeys.clear();
  markedEvents = new WeakSet<TandemEvent>();
  open = false;
  owedAtSwitch = new Set();
  heldSelections.clear();
  supervisorListeners.clear();
  unsubscribeSwitch?.();
  unsubscribeSwitch = null;
  hooks = null;
}

/** For tests: is a local period recorded as open? */
export function __localPeriodOpenForTests(): boolean {
  return open;
}
