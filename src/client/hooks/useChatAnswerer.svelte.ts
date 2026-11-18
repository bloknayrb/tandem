import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import {
  API_MODELS_CHAT_ANSWERER,
  CHAT_ANSWERER_NOTICE_KEYS,
  type ChatAnswerer,
  ERROR_CODE_CHAT_ANSWERER_SUPERSEDED,
  ERROR_CODE_CHAT_ANSWERER_WRITE_FAILED,
  ERROR_CODE_OWN_WINDOW_ONLY,
  LOCAL_MODEL_STATES,
  type LocalModelState,
} from "../../shared/models/contract.js";
import type { ChatMessage, TandemMode, TandemNotification } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { onModelsWriteCommitted } from "../models/models-write-signal.js";
import { noteModelsWriteRefused } from "../models/write-refusal.js";
import { LOCAL_COMMENT_INFO_TEXT } from "../status/addressed-ai-notice.js";
import { API_BASE } from "../utils/fileUpload.js";
import { modelsPageAccess } from "./useModelsWriteAccess.svelte.js";
import type { ToastAction } from "./useNotifications.svelte.js";

/**
 * The editor's read of who answers chat (#1123 part B, R1): Claude, or the
 * local model. The server owns the switch (`chat-answerer.json`); this is the
 * one place in the client that reads it, and every surface — the Settings
 * control, the chat pickup row, the status pill, the send-time toast — reads
 * this store. None fetches on its own.
 *
 * **The read** (the brief's Terms) is the last answer from
 * `GET /api/models/chat-answerer`: `known` (the switch, the local model's
 * state, the server's run id), `pending` (no answer yet), `refused` (403
 * `OWN_WINDOW_ONLY`: a dev page with no allowance, a browser that sends no
 * `Sec-Fetch-Site`), `unreadable` (the page's own origin is one the server
 * never answers readably, `"foreign"`), `failed` (any other error, a malformed
 * answer or a timeout), or `unavailable` (a lit editor against a server that
 * answers 404). A re-read keeps the last known answer until it settles, so
 * every surface reads the last known answer meanwhile (R1.1).
 *
 * **One read at a time** (Ruling B-3). A trigger while a read is in flight
 * queues exactly ONE more read after it; further triggers in that time share
 * it. There is no polling: a read happens only when a trigger fires (R1.2).
 *
 * **Never inside a reaction.** `requestRead` writes no `$state` in its
 * caller's frame: the read starts on a microtask. Every trigger entry point
 * below touches only plain bookkeeping and then calls it, so a trigger fired
 * from inside an `$effect` writes nothing synchronously (R1.2). The setter
 * writes `$state` synchronously, but is only ever called from a click or key
 * handler.
 *
 * **Dark.** One guard: `requestRead` and the setter return at
 * `!BYO_MODELS_ENABLED`, before any bookkeeping, and every trigger goes
 * through `requestRead`. The models-write listener is registered only under
 * the flag. Nothing here runs at import time while dark.
 */

export type ChatAnswererReadStatus =
  | "pending"
  | "known"
  | "refused"
  | "unreadable"
  | "failed"
  | "unavailable";

/** The local model's state from a known read; `"threw"` when the server's
 *  check threw (the field was absent): neither usable nor unusable. */
export type LocalModelReadState = LocalModelState | "threw";

/** What one read ended in. `"dark"` only while the flag is off. */
export type ReadOutcome =
  | {
      status: "known";
      answerer: ChatAnswerer;
      localModelState: LocalModelReadState;
      runGeneration: string;
    }
  | { status: Exclude<ChatAnswererReadStatus, "known" | "pending"> }
  | { status: "dark" };

/** Long enough for a busy loopback server, short enough that a hung one ends
 *  in the failed state while the user is still looking. */
export const REQUEST_TIMEOUT_MS = 10_000;
const url = `${API_BASE}${API_MODELS_CHAT_ANSWERER}`;

// --- Reactive state ------------------------------------------------------------

let _status = $state<ChatAnswererReadStatus>("pending");
let _answerer = $state<ChatAnswerer>("claude");
let _localModelState = $state<LocalModelReadState>("none");
let _runGeneration = $state<string | null>(null);
let _reading = $state(false);
let _postPending = $state(false);
/** R2.4's outcome line (`role="alert"`), or null. */
let _outcomeLine = $state<string | null>(null);
/** R2.6: "Set chat to Claude" answered 200 on a page whose read is refused. */
let _setToClaudeDone = $state(false);
/** Messages THIS window sent while its read was known local and the licence
 *  admitted AI (Ruling B-6). Replaced, never mutated. In memory only. */
let _sentLocal = $state<ReadonlySet<string>>(new Set());

// --- Plain bookkeeping (never read by a template) ------------------------------

let _inFlight: Promise<ReadOutcome> | null = null;
let _next: Promise<ReadOutcome> | null = null;
/** Bumped when a POST settles: a read that started before it is stale. */
let _postEpoch = 0;
/** A switch's POST is on the wire (reads that settle meanwhile are not
 *  adopted). `_postPending` stays set longer, through its re-read. */
let _postInFlight = false;
/** Bumped by every clear of the outcome line: a switch whose tail finds it
 *  changed (the tab closed, or the user is selecting again) writes no line. */
let _outcomeToken = 0;
/** Bumped when a new server process is detected: a read that started
 *  against the old one would write its run id back. */
let _processEpoch = 0;
/** The answer an R2.4 outcome line was shown beside; a later read with a
 *  different answer clears the line (it would contradict what is shown). */
let _outcomeFor: ChatAnswerer | null = null;
/** `runGeneration` values a running `localRun` has triggered a read for. */
let _generationsTriggered = new Set<string>();
let _lastHeld: boolean | null = null;
let _lastCtrlDoc: object | null = null;
/** Per CTRL doc: each user row's last observed `localRun` and stamps. */
let _observedDoc: object | null = null;
let _userRows = new Map<string, { run: string | null; stamped: boolean }>();
/** R3: where the first-local-model toast goes (App's `notifications`). */
let _toastSink: ChatAnswererToastSink | null = null;
let _toastShownInMemory = false;
/** The id the first-local-model confirmation was pushed with, until it is
 *  withdrawn ("Use it for chat", R3.3). Plain: no template reads it. */
let _confirmationId: string | null = null;
/** The last chat send's own read (#2433 M1, Ruling S-a): the promise its
 *  `requestRead()` returned and the local period at the send. Replaced by every
 *  `noteChatSent`, cleared by `takeSendRead`. Plain, not `$state`: no template
 *  reads it, and the take writes it from inside an event handler. */
let _sendRead: { read: Promise<ReadOutcome>; localPeriodAtSend: boolean } | null = null;
/** Cap timers started by `takeSendRead` and not yet fired or cleared. Two
 *  readers, both test-only: the test reset clears them, and
 *  `_capTimerCountForTests` counts them. */
let _capTimers = new Set<ReturnType<typeof setTimeout>>();

// --- The read --------------------------------------------------------------------

function validLocalModelState(v: unknown): v is LocalModelState {
  return typeof v === "string" && (LOCAL_MODEL_STATES as readonly string[]).includes(v);
}

async function fetchRead(): Promise<ReadOutcome> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // A page whose own origin the server never answers readably cannot read
    // any answer at all: that is not a failure a Retry could fix.
    if (modelsPageAccess() === "foreign") return { status: "unreadable" };
    console.warn("[chat-answerer] read failed", err);
    return { status: "failed" };
  }
  if (res.status === 404) return { status: "unavailable" };
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 403 && body?.code === ERROR_CODE_OWN_WINDOW_ONLY) return { status: "refused" };
  if (
    res.status !== 200 ||
    body === null ||
    (body.answerer !== "claude" && body.answerer !== "local") ||
    typeof body.runGeneration !== "string" ||
    !("localModelState" in body
      ? validLocalModelState(body.localModelState)
      : body.localModelResolves === false)
  ) {
    console.warn(`[chat-answerer] unreadable answer (${res.status})`);
    return { status: "failed" };
  }
  return {
    status: "known",
    answerer: body.answerer,
    localModelState:
      "localModelState" in body ? (body.localModelState as LocalModelState) : "threw",
    runGeneration: body.runGeneration,
  };
}

function adopt(outcome: ReadOutcome): void {
  if (outcome.status === "dark") return;
  if (_outcomeLine !== null && (outcome.status !== "known" || outcome.answerer !== _outcomeFor)) {
    // The line was true for the answer it came with, not for this one.
    _outcomeLine = null;
  }
  if (outcome.status === "known") {
    // The radios now show the switch; the past-tense line is no longer needed.
    _setToClaudeDone = false;
    _answerer = outcome.answerer;
    _localModelState = outcome.localModelState;
    _runGeneration = outcome.runGeneration;
  }
  _status = outcome.status;
  // The confirmation says chat is set to Claude: no longer true (CR-4).
  if (outcome.status === "known" && outcome.answerer === "local") withdrawConfirmation();
}

function startRead(): Promise<ReadOutcome> {
  const epoch = _postEpoch;
  const processEpoch = _processEpoch;
  // The promise is read inside its own body (the `finally`), so it is held in
  // a slot assigned after construction.
  const slot: { read?: Promise<ReadOutcome> } = {};
  const read: Promise<ReadOutcome> = (async () => {
    // Off the caller's frame: a trigger fired inside a reaction writes nothing.
    await Promise.resolve();
    _reading = true;
    try {
      const outcome = await fetchRead();
      // A switch that settled while this read was in flight already told us
      // more than this read can, and its own re-read is on its way.
      // So did a new server process: this read may have been answered by the
      // old one (its run id would be written back).
      if (epoch === _postEpoch && processEpoch === _processEpoch && !_postInFlight) adopt(outcome);
      return outcome;
    } finally {
      if (_inFlight === slot.read) _inFlight = null;
      // A queued read still counts: otherwise a failed read followed by a
      // queued one would flash the "couldn't read" alert for one flush.
      _reading = _inFlight !== null || _next !== null;
    }
  })();
  slot.read = read;
  _inFlight = read;
  return read;
}

/**
 * Read the switch. Resolves with the outcome of a read that STARTED after this
 * call. Never writes `$state` in the caller's frame. No-op while dark.
 */
export function requestRead(): Promise<ReadOutcome> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve({ status: "dark" });
  if (_next) return _next;
  if (_inFlight) {
    const settle = () => {
      _next = null;
      return startRead();
    };
    const next = _inFlight.then(settle, settle);
    _next = next;
    return next;
  }
  return startRead();
}

// --- The switch (R2.2–R2.6) ----------------------------------------------------

const LINE_CLAUDE_NOT_SAVED =
  "Chat is set to Claude now, but this change could not be fully saved. After Tandem restarts, chat may be set to your local model again, or Tandem may tell you the setting changed.";
const LINE_LOCAL_NOT_SAVED =
  "Chat is set to your local model now, but this change could not be saved, so chat may be set to Claude again after Tandem restarts.";
const LINE_LOCAL_REFUSED = "Chat could not be set to your local model. It is still set to Claude.";
const LINE_UNCONFIRMED = "That change could not be confirmed. Showing the current setting.";
const LINE_UNCONFIRMED_UNREAD =
  "That change could not be confirmed, and the current setting could not be read.";

/** Every R2.4 outcome line, for tests and the PR's string list. */
export const CHAT_ANSWERER_OUTCOME_LINES = {
  claudeNotSaved: LINE_CLAUDE_NOT_SAVED,
  localNotSaved: LINE_LOCAL_NOT_SAVED,
  localRefused: LINE_LOCAL_REFUSED,
  unconfirmed: LINE_UNCONFIRMED,
  unconfirmedUnread: LINE_UNCONFIRMED_UNREAD,
} as const;

/**
 * What one switch's POST answered ("Use it for chat", R3.1), decided by the
 * POST alone, never by the re-read after it.
 */
export type SwitchResult =
  | { kind: "not-sent" }
  | { kind: "answered"; effective: ChatAnswerer; saved: boolean; superseded: boolean }
  | { kind: "unconfirmed" };

/**
 * Send the switch (R2.2). Only ever called from the user's own selection — a
 * click, Space or Enter on a radio, "Set chat to Claude", or a press of the
 * first-local-model confirmation's "Use it for chat" (Bryan's P5) — never on
 * mount, a read, a models save or a retry. Never throws. No-op (`not-sent`)
 * while dark, while a switch is already pending, and for the local model while
 * the read is not known. Otherwise it returns what the POST answered, on every
 * path, including when the outcome line is no longer wanted.
 */
export async function setChatAnswerer(value: ChatAnswerer): Promise<SwitchResult> {
  if (!BYO_MODELS_ENABLED) return { kind: "not-sent" };
  if (_postPending) return { kind: "not-sent" };
  // A page that cannot see the switch never sends it to the local model
  // (R2.2, R2.6); "Set chat to Claude" is the one send allowed then.
  if (value === "local" && _status !== "known") return { kind: "not-sent" };
  // Pending until its own re-read settles, so a second press cannot start
  // another POST during that re-read.
  _postPending = true;
  _postInFlight = true;
  _outcomeLine = null;
  _outcomeFor = null;
  const token = ++_outcomeToken;
  const readBefore = _status;
  let line: string | null = null;
  let unconfirmed = false;
  /** The server answered that chat is set to Claude, as asked (R2.6). */
  let setToClaude = false;
  let result: SwitchResult = { kind: "unconfirmed" };
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerer: value }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const effective =
      body && (body.answerer === "claude" || body.answerer === "local") ? body.answerer : null;
    if (res.status === 403 && body?.code === ERROR_CODE_OWN_WINDOW_ONLY) {
      // Refused: nothing changed. The tab's own-window notice explains, once.
      noteModelsWriteRefused();
    } else if (
      effective !== null &&
      (res.status === 200 ||
        (res.status === 409 && body?.code === ERROR_CODE_CHAT_ANSWERER_SUPERSEDED))
    ) {
      // The server's body always carries the value in effect: adopt it.
      if (readBefore === "known") _answerer = effective;
      if (effective === "local") withdrawConfirmation();
      setToClaude = effective === "claude" && value === "claude";
      result =
        res.status === 200
          ? { kind: "answered", effective, saved: true, superseded: false }
          : { kind: "answered", effective, saved: body?.persisted === true, superseded: true };
    } else if (
      effective !== null &&
      res.status === 500 &&
      body?.code === ERROR_CODE_CHAT_ANSWERER_WRITE_FAILED
    ) {
      if (readBefore === "known") _answerer = effective;
      if (effective === "local") withdrawConfirmation();
      result = { kind: "answered", effective, saved: false, superseded: false };
      line =
        effective !== value
          ? LINE_LOCAL_REFUSED
          : value === "claude"
            ? LINE_CLAUDE_NOT_SAVED
            : LINE_LOCAL_NOT_SAVED;
    } else {
      throw new Error(`POST ${API_MODELS_CHAT_ANSWERER} → ${res.status}`);
    }
  } catch (err) {
    // The request may or may not have landed (a timeout may still land). Ask.
    console.warn("[chat-answerer] switch failed", err);
    unconfirmed = true;
    result = { kind: "unconfirmed" };
  } finally {
    _postInFlight = false;
    _postEpoch += 1;
  }
  let outcome: ReadOutcome;
  try {
    outcome = await requestRead();
  } finally {
    _postPending = false;
  }
  if (unconfirmed) line = outcome.status === "known" ? LINE_UNCONFIRMED : LINE_UNCONFIRMED_UNREAD;
  // R2.6: a page whose re-read still cannot show the switch says, in the past
  // tense, that the press worked — never leaving it with nothing said.
  if (setToClaude && outcome.status !== "known" && outcome.status !== "dark") {
    _setToClaudeDone = true;
  }
  // The tab closed, or the user pressed again, while this was in flight: the
  // line belongs to a press nobody is looking at any more.
  if (token !== _outcomeToken) return result;
  // Shown beside the answer this re-read gave, and only while it holds.
  _outcomeFor = outcome.status === "known" ? outcome.answerer : null;
  _outcomeLine = line;
  return result;
}

/** The tab body unmounted, or the user is selecting again: an outcome line
 *  belongs to the press that produced it and is not shown again later. */
export function clearChatAnswererOutcome(): void {
  _outcomeToken += 1;
  _outcomeLine = null;
  _outcomeFor = null;
}

// --- Triggers (R1.2) -----------------------------------------------------------

/**
 * The editor's CTRL connection synced. A doc other than the last one synced is
 * a new server process (a new generation rebuilds the provider on a new doc):
 * its run id is not known until the read answers, so `runGeneration` is
 * cleared — on the microtask, never in the caller's frame — and the answer and
 * the local model's state stay last-known meanwhile.
 */
export function noteCtrlSynced(doc: object): void {
  if (!BYO_MODELS_ENABLED) return;
  if (doc === _lastCtrlDoc) return;
  const newProcess = _lastCtrlDoc !== null;
  _lastCtrlDoc = doc;
  if (newProcess) {
    _processEpoch += 1;
    // On a microtask, not here: this is called from App's effect, and no
    // `$state` is written inside a reaction (R1.2). The cost is that the
    // pickup row may change twice (run id cleared, then the read's), one
    // flush apart.
    queueMicrotask(() => {
      _runGeneration = null;
    });
  }
  void requestRead();
}

/** A notify-stream notice arrived (`useNotifications`' `onStreamNotice`). */
export function noteNotifyNotice(dedupKey: string | undefined): void {
  if (!BYO_MODELS_ENABLED) return;
  if (dedupKey !== undefined && CHAT_ANSWERER_NOTICE_KEYS.includes(dedupKey)) void requestRead();
}

/** A notice row arrived live (the reply detector's baseline says it is new). */
export function noteNoticeRowArrived(): void {
  if (!BYO_MODELS_ENABLED) return;
  void requestRead();
}

/**
 * `heldForLocalModel`, read through the same freshness gate as the pill's
 * running status (Ruling B-16), changed. The first value seen is a baseline.
 */
export function noteHeld(held: boolean): void {
  if (!BYO_MODELS_ENABLED) return;
  const before = _lastHeld;
  _lastHeld = held;
  if (before !== null && before !== held) void requestRead();
}

/**
 * Watch the user's chat rows for the three row-based triggers (R1.2). Only
 * changes seen AFTER the chat synced count: the first synced pass over a CTRL
 * doc records every user row as it stands, so history never triggers. Call
 * from App's chat effect inside `untrack`; it writes no `$state`.
 */
export function observeChatForAnswerer(input: {
  doc: object;
  synced: boolean;
  messages: readonly ChatMessage[];
}): void {
  if (!BYO_MODELS_ENABLED || !input.synced) return;
  const seeding = _observedDoc !== input.doc;
  if (seeding) {
    _observedDoc = input.doc;
    _userRows = new Map();
  }
  let trigger = false;
  for (const m of input.messages) {
    if (m.author !== "user") continue;
    const run = m.localRun ? `${m.localRun.status}:${m.localRun.generation}` : null;
    const stamped = m.read === true || m.delivered === true;
    const before = _userRows.get(m.id);
    _userRows.set(m.id, { run, stamped });
    const r = m.localRun;
    if (seeding) {
      // History's running states are a baseline: a row left `running` by a
      // crashed process does not fire a read on the first chat change.
      if (r?.status === "running") _generationsTriggered.add(r.generation);
      continue;
    }
    // A run stamped by a server process this read has not answered for (once
    // per such run id).
    if (
      r?.status === "running" &&
      r.generation !== _runGeneration &&
      !_generationsTriggered.has(r.generation)
    ) {
      _generationsTriggered.add(r.generation);
      trigger = true;
    }
    // `localRun` appeared while the read says Claude (the switch may have
    // moved in another window), or while the read is not known at all (a
    // failed re-read during a real local period: without this nothing would
    // read again, review round 1 item 2).
    if (
      r &&
      (before === undefined || before.run === null) &&
      (isKnownClaude() || _status !== "known")
    ) {
      trigger = true;
    }
    // A Claude took the message while the read says local: the switch may
    // have moved back in another window with no chat line and no notice.
    if (stamped && (before === undefined || !before.stamped) && isKnownLocal()) trigger = true;
  }
  if (trigger) void requestRead();
}

/**
 * This window sent a chat message (`useChatState`'s `onSent`, from the send
 * handler). Recorded for "Sent to your local model" only when the read is
 * known local and the licence admits AI (Ruling B-6); a send in the local
 * period is also a trigger, which ends a stale "known local" read.
 */
export function noteChatSent(message: ChatMessage, opts: { aiOff: boolean; held: boolean }): void {
  if (!BYO_MODELS_ENABLED) return;
  // The local period at the send, from the caller's `held` (Ruling S-c).
  const localPeriodAtSend = inLocalPeriod(opts.held);
  if (isKnownLocal() && !opts.aiOff) {
    const next = new Set(_sentLocal);
    next.add(message.id);
    _sentLocal = next;
  }
  // In the local period, or with the read not known (review round 1 item 2):
  // one read, no loop — a send is a user event.
  const read = localPeriodAtSend || _status !== "known" ? requestRead() : null;
  // Replaced on every send, with nothing when this send requested no read, so
  // a later send can never wait on a read an earlier one requested.
  _sendRead = read === null ? null : { read, localPeriodAtSend };
}

/** A chat send's own read, taken by the send-time toast (#2433 M1). */
export interface SendReadWait {
  /** Settles when the send's read settles, or at `REQUEST_TIMEOUT_MS` from
   *  the take, whichever comes first. Never rejects. */
  readonly wait: Promise<void>;
  /** `inLocalPeriod(held)` at the send. */
  readonly localPeriodAtSend: boolean;
}

/**
 * Take the last chat send's own read (#2433 M1), clearing it. Null when that
 * send requested no read (a known-Claude send), when none was recorded, and
 * always while dark (`noteChatSent` records nothing then: its guard is the only
 * one, on purpose). The capped wait starts HERE, so it runs concurrently with
 * whatever the caller awaits next. Writes no `$state`.
 */
export function takeSendRead(): SendReadWait | null {
  const record = _sendRead;
  _sendRead = null;
  if (record === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      if (timer !== undefined) _capTimers.delete(timer);
      resolve();
    }, REQUEST_TIMEOUT_MS);
    _capTimers.add(timer);
  });
  // A catch at once: a read that rejects while nobody settles is never an
  // unhandled rejection. The cap timer is cleared when the read settles first.
  const readDone = record.read.then(
    () => undefined,
    () => undefined,
  );
  void readDone.then(() => {
    if (timer === undefined) return;
    clearTimeout(timer);
    _capTimers.delete(timer);
  });
  return { wait: Promise.race([readDone, cap]), localPeriodAtSend: record.localPeriodAtSend };
}

/**
 * The local period for a send's toast, after its own read (#2433 M1): live
 * (the store's answer is local) if the read is KNOWN once the wait ends,
 * otherwise the value recorded at the send. "Known" is the store's read at
 * that moment, which may be another trigger's read rather than this send's
 * (at the cap, or when this send's answer was not adopted). For a read that
 * was not queued, its fetch timeout and the cap are the same length, and this
 * rule answers the same whichever fires first; a queued read's timeout runs
 * from its own later start, so the cap comes first. Never rejects: any error
 * yields the value at the send.
 */
export async function settleSendLocalPeriod(handle: SendReadWait): Promise<boolean> {
  try {
    await handle.wait;
  } catch {
    return handle.localPeriodAtSend;
  }
  return _status === "known" ? _answerer === "local" : handle.localPeriodAtSend;
}

/** Test seam — how many cap timers are pending (none once each settled). */
export function _capTimerCountForTests(): number {
  return _capTimers.size;
}

/** Test seam — plant a send's record whose read the test controls. */
export function _setSendReadForTests(read: Promise<ReadOutcome>, localPeriodAtSend: boolean): void {
  _sendRead = { read, localPeriodAtSend };
}

function isKnownLocal(): boolean {
  return _status === "known" && _answerer === "local";
}
function isKnownClaude(): boolean {
  return _status === "known" && _answerer === "claude";
}

/**
 * The local period, for the editor (Ruling B-16): a KNOWN read always wins;
 * `held` counts only when the read is not known, and the caller passes it
 * through the same freshness gate as the pill's running status.
 */
export function inLocalPeriod(heldFresh: boolean): boolean {
  if (!BYO_MODELS_ENABLED) return false;
  if (_status === "known") return _answerer === "local";
  return heldFresh;
}

/** What the pill's label claims (Ruling B-17), or null out of the local period. */
export type LocalChatSetting = "local" | "unusable";

export function localChatSettingFor(
  read: {
    status: ChatAnswererReadStatus;
    answerer: ChatAnswerer;
    localModelState: LocalModelReadState;
  },
  heldFresh: boolean,
): LocalChatSetting | null {
  if (read.status === "known") {
    if (read.answerer !== "local") return null;
    return read.localModelState === "usable" || read.localModelState === "threw"
      ? "local"
      : "unusable";
  }
  return heldFresh ? "local" : null;
}

// --- The send notice: a card send in the local period -------------------------

/**
 * The decision behind a card send's raise (#1123, the send notice; ADR-039's
 * amendment of 2026-11-18). App fills `panels/card-send-raise.ts`'s seam with
 * the returned function, under `BYO_MODELS_ENABLED`. First match wins (the
 * reviewing session's ruling):
 *   1. Solo: nothing (the user opted out of AI surfacing; Ruling B-7's notice
 *      is the composer's, which returns in Solo too).
 *   2. Server unreachable (the polled flag): nothing. W would say "Saved ...
 *      waits" for a write a server restart can drop, and an offline toast would
 *      rest on a flag that clears only on the next answered poll; the card makes
 *      no probe, so it says nothing, as on master.
 *   3. The local period (`inLocalPeriod`, Ruling B-16: a known read wins, held
 *      counts only when the read is not known): the composer's `local-comment`
 *      info toast with W, same dedupKey, so the two coalesce.
 *   4. Otherwise nothing.
 * No flag check of its own: dark, `inLocalPeriod` is false at its first line.
 * No `no-agent` parity (R3.3): every non-`ai-off` chip rests on the polled
 * `sessionLive`, which can be stale without a probe.
 *
 * Creating it reads no getter (App builds it before `aiReadiness` exists), and
 * no value is cached: each raise reads them all. It reads nothing about the
 * annotation, fetches nothing and dispatches nothing (ADR-027; R3.2). Its
 * callers refuse at click while the licence refuses AI, so it has no licence
 * row of its own.
 */
export function createCardSendNotice(deps: {
  getHeld: () => boolean;
  getMode: () => TandemMode;
  getServerUnreachable: () => boolean;
  push: (n: TandemNotification) => void;
}): () => void {
  return () => {
    if (deps.getMode() === "solo") return;
    if (deps.getServerUnreachable()) return;
    if (!inLocalPeriod(deps.getHeld())) return;
    const now = Date.now();
    // The composer's id and dedupKey shape (Ruling SN-4): `${idPrefix}-${viaKey}`.
    deps.push({
      id: `ai-local-comment-comment-${now}`,
      type: "launcher",
      severity: "info",
      message: LOCAL_COMMENT_INFO_TEXT,
      dedupKey: "ai-local-comment-comment",
      timestamp: now,
    });
  };
}

// --- R3: the first local model's toast, and "Use it for chat" -------------------
//
// Decision B4's confirmation, pushed by `onModelsWrite` (the brief "Use it for
// chat", R2, first match wins): dark, nothing (no listener, no sink); a read
// that is not known or is known local, or a store that already knows local
// when the read settles, dropped; a known-Claude read in ANY local-model state
// (CR-1), the confirmation with the "Use it for chat" action, which stays
// until pressed or closed (W2). Its press (`pressUseItForChat`, R3.2) re-reads
// and sends the switch; the confirmation is withdrawn, toast and tray row,
// whenever the store's answerer becomes local (R3.3).

export const FIRST_LOCAL_MODEL_TOAST_KEY = "tandem:first-local-model-chat-toast";
export const FIRST_LOCAL_MODEL_TOAST_TEXT =
  "Chat is still set to Claude. To use your local model for chat, choose Local model under Who answers your chat in Settings → Models.";

function toastAlreadyShown(): boolean {
  if (_toastShownInMemory) return true;
  try {
    return localStorage.getItem(FIRST_LOCAL_MODEL_TOAST_KEY) === "1";
  } catch {
    return false;
  }
}

function markToastShown(): void {
  _toastShownInMemory = true;
  try {
    localStorage.setItem(FIRST_LOCAL_MODEL_TOAST_KEY, "1");
  } catch {
    // Storage disabled: kept in memory for this run (R3.3).
  }
}

/** Where this store's toasts go: App's `notifications`, under the flag. */
export interface ChatAnswererToastSink {
  push: (n: TandemNotification, action?: ToastAction) => void;
  dismiss: (id: string) => void;
  dismissActivity: (id: string) => void;
}

/** App hands over its notifications, under the flag. */
export function setChatAnswererToastSink(sink: ChatAnswererToastSink | null): void {
  _toastSink = sink;
}

export const USE_IT_FOR_CHAT_LABEL = "Use it for chat";

/** The press's notices (R4), by the result they report. */
export const USE_IT_FOR_CHAT_NOTICES = {
  set: {
    severity: "info",
    dedupKey: "use-it-for-chat-set",
    message: "Chat was set to your local model.",
  },
  notSaved: {
    severity: "warning",
    dedupKey: "use-it-for-chat-not-saved",
    message:
      "Chat was set to your local model, but Tandem could not save that choice, so chat may be set back to Claude when Tandem restarts.",
  },
  refused: {
    severity: "warning",
    dedupKey: "use-it-for-chat-refused",
    message: "Chat could not be set to your local model. It was left set to Claude.",
  },
  notConfirmed: {
    severity: "warning",
    dedupKey: "use-it-for-chat-not-confirmed",
    message:
      "Tandem could not confirm that chat was set to your local model. You can set it under Who answers your chat in Settings → Models.",
  },
  notRead: {
    severity: "warning",
    dedupKey: "use-it-for-chat-not-read",
    message:
      "Chat was not set to your local model, because Tandem could not read the current setting. You can set it under Who answers your chat in Settings → Models.",
  },
} as const satisfies Record<
  string,
  { severity: TandemNotification["severity"]; dedupKey: string; message: string }
>;

function pushUseItNotice(notice: keyof typeof USE_IT_FOR_CHAT_NOTICES): void {
  _toastSink?.push({
    id: generateNotificationId(),
    type: "launcher",
    ...USE_IT_FOR_CHAT_NOTICES[notice],
    timestamp: Date.now(),
  });
}

/**
 * Take the confirmation down, toast and tray row (R3.3): chat is now set to
 * the local model, so "Chat is still set to Claude" and its button would be
 * false. Each sink call is guarded on its own, so a throwing sink never
 * rejects a read or breaks `setChatAnswerer`'s "never throws".
 */
function withdrawConfirmation(): void {
  const id = _confirmationId;
  if (id === null) return;
  _confirmationId = null;
  try {
    _toastSink?.dismiss(id);
  } catch (err) {
    console.warn("[chat-answerer] could not dismiss the confirmation", err);
  }
  try {
    _toastSink?.dismissActivity(id);
  } catch (err) {
    console.warn("[chat-answerer] could not remove the confirmation's tray row", err);
  }
}

/**
 * The press of "Use it for chat" (R3.2; Bryan's P5, a selection under Ruling
 * B-1). First match wins: dark, nothing; a switch pending at the click,
 * nothing (no read, Settings' line untouched; CR-3); then, after a fresh read
 * (CR-5), from the STORE: known local, nothing (re-sending would upgrade the
 * server's "told" to "chosen", #2417); still not known, X; otherwise one
 * `setChatAnswerer("local")`, reported by its POST's result (CR-2). No return
 * on a missing confirmation id: the rows run regardless. Never writes
 * `$state` itself; only from the click and the fetch continuations below it.
 */
export async function pressUseItForChat(): Promise<void> {
  if (!BYO_MODELS_ENABLED) return;
  if (_postPending) return;
  await requestRead();
  if (isKnownLocal()) return;
  if (_status !== "known") {
    pushUseItNotice("notRead");
    return;
  }
  const result = await setChatAnswerer("local");
  // A switch began during the press's read: Settings owns that one.
  if (result.kind === "not-sent") return;
  // This notice carries the result; a line left behind would be announced at
  // the next Settings → Models open, against the tab's rule.
  clearChatAnswererOutcome();
  if (result.kind === "unconfirmed") pushUseItNotice("notConfirmed");
  else if (result.effective === "local") pushUseItNotice(result.saved ? "set" : "notSaved");
  // A superseded Claude: another choice won, and Settings says nothing either.
  else if (!result.superseded) pushUseItNotice("refused");
}

function onModelsWrite(info: { firstLocal: boolean }): void {
  const read = requestRead();
  if (!info.firstLocal || toastAlreadyShown()) return;
  void read
    .then((outcome) => {
      if (outcome.status !== "known") return; // not known: dropped, unmarked
      if (toastAlreadyShown()) return;
      markToastShown();
      // Known local: it would be false, so it is dropped (and marked).
      if (outcome.answerer !== "claude") return;
      // The store already knows local (a switch settled while this read was in
      // flight, so the read was not adopted): it would be false too.
      if (isKnownLocal()) return;
      const sink = _toastSink;
      if (sink === null) return;
      const id = generateNotificationId();
      // The withdrawal finds the toast and its tray row by this id. Nothing
      // else pushes this dedupKey; a coalescing push would give the toast a
      // new id.
      _confirmationId = id;
      sink.push(
        {
          id,
          // The send-time toasts' type: a notice about who answers chat.
          type: "launcher",
          severity: "info",
          message: FIRST_LOCAL_MODEL_TOAST_TEXT,
          dedupKey: "first-local-model-chat",
          timestamp: Date.now(),
        },
        {
          label: USE_IT_FOR_CHAT_LABEL,
          onClick: () =>
            void pressUseItForChat().catch((err) =>
              console.warn("[chat-answerer] Use it for chat failed", err),
            ),
          // W2: it holds a button the user may want, so it waits.
          stay: true,
        },
      );
    })
    .catch((err) => console.warn("[chat-answerer] the first-local-model toast failed", err));
}

let _unsubscribeModelsWrite: (() => void) | null = BYO_MODELS_ENABLED
  ? onModelsWriteCommitted(onModelsWrite)
  : null;

// --- The facade ------------------------------------------------------------------

export interface ChatAnswererState {
  readonly status: ChatAnswererReadStatus;
  readonly known: boolean;
  /** Meaningful only while `known`. */
  readonly answerer: ChatAnswerer;
  readonly localModelState: LocalModelReadState;
  /** The server process's run id, or null when not known. */
  readonly runGeneration: string | null;
  readonly reading: boolean;
  readonly postPending: boolean;
  readonly outcomeLine: string | null;
  readonly setToClaudeDone: boolean;
  readonly sentLocal: ReadonlySet<string>;
  load: () => Promise<ReadOutcome>;
  set: (value: ChatAnswerer) => Promise<void>;
  clearOutcome: () => void;
}

export function createChatAnswerer(): ChatAnswererState {
  return {
    get status() {
      return _status;
    },
    get known() {
      return _status === "known";
    },
    get answerer() {
      return _answerer;
    },
    get localModelState() {
      return _localModelState;
    },
    get runGeneration() {
      return _runGeneration;
    },
    get reading() {
      return _reading;
    },
    get postPending() {
      return _postPending;
    },
    get outcomeLine() {
      return _outcomeLine;
    },
    get setToClaudeDone() {
      return _setToClaudeDone;
    },
    get sentLocal() {
      return _sentLocal;
    },
    load: requestRead,
    // The tab needs no result; `Promise<SwitchResult>` is not `Promise<void>`.
    set: async (value) => {
      await setChatAnswerer(value);
    },
    clearOutcome: clearChatAnswererOutcome,
  };
}

/** Test seam — reset the module singleton. */
export function _resetChatAnswererForTests(): void {
  _status = "pending";
  _answerer = "claude";
  _localModelState = "none";
  _runGeneration = null;
  _reading = false;
  _postPending = false;
  _postInFlight = false;
  _outcomeToken = 0;
  _outcomeLine = null;
  _setToClaudeDone = false;
  _sentLocal = new Set();
  _inFlight = null;
  _next = null;
  _postEpoch = 0;
  _processEpoch = 0;
  _outcomeFor = null;
  _generationsTriggered = new Set();
  _lastHeld = null;
  _lastCtrlDoc = null;
  _observedDoc = null;
  _userRows = new Map();
  _toastSink = null;
  _toastShownInMemory = false;
  _confirmationId = null;
  _sendRead = null;
  for (const timer of _capTimers) clearTimeout(timer);
  _capTimers = new Set();
  _unsubscribeModelsWrite?.();
  _unsubscribeModelsWrite = BYO_MODELS_ENABLED ? onModelsWriteCommitted(onModelsWrite) : null;
}
