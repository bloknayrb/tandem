import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import {
  API_MODELS_LOCAL_SETTINGS,
  ERROR_CODE_OWN_WINDOW_ONLY,
  type LocalModelSettingsPostResponse,
  type LocalModelSettingsResponse,
} from "../../shared/models/contract.js";
import { noteModelsWriteRefused } from "../models/write-refusal.js";
import { API_BASE } from "../utils/fileUpload.js";

/**
 * Client mirror of the server's "let local models comment and suggest changes"
 * setting (#1123, ADR-039's opt-in tier). The server owns it
 * (`local-model-settings.json`); this is what the Models tab shows.
 *
 * **Dark guarantee.** Both `loadLocalModelSettings` and `setLocalModelEditing`
 * return before any fetch while `BYO_MODELS_ENABLED` is false, the module has
 * no top-level side effect, and nothing calls it at boot — the only caller is
 * the Models tab, which is not mounted while dark.
 *
 * **The checkbox must never show a state the server does not hold.** So:
 *  - a click applies optimistically, then the server's answer is adopted — every
 *    answer carries the value the server is acting on, including a failed save;
 *  - `known` is false until a load or a save has told us the server's value.
 *    The tab then shows the box indeterminate and inert — it claims nothing and
 *    a click on it does nothing — with Retry and an explicit "Switch off"
 *    beside it, because an unticked live box would claim "off" and could only
 *    be clicked to On;
 *  - loads and saves share ONE queue, so they reach the server, and are
 *    applied here, strictly in the order they were asked for: a read can never
 *    overwrite what a later save learned, and a save never waits on nothing;
 *  - the DISPLAYED value follows the user's last click until that click's own
 *    answer arrives: an answer from a load, or from an older save, that lands
 *    while a later save is still queued is not shown (it would flip the box
 *    back and forth under the user's hand);
 *  - a read that fails drops back to "unknown" rather than keep showing a value
 *    that another window or a restart may have changed;
 *  - every request has a timeout, so a hung server ends in the unknown state
 *    (with its Switch off) instead of a box that never settles.
 *
 * There is no live refresh: the value is read when the Models tab mounts. A
 * change made in another window shows up the next time the tab is opened.
 *
 * `$state` is written only from event handlers and promise continuations, never
 * inside a reaction.
 */

let _editing = $state(false);
let _known = $state(false);
let _loading = $state(false);
let _loadFailed = $state(false);
let _saveNotice = $state<string | null>(null);

let _loadInFlight: Promise<void> | null = null;
/** Aborts the read in flight. A save does this so it is never held up behind
 *  a read that is slow or hung — above all "Switch off". */
let _loadAbort: AbortController | null = null;
/** Loads and saves, one at a time, in request order. */
let _queue: Promise<void> = Promise.resolve();
/** Saves asked for and not yet answered. While any is outstanding the display
 *  belongs to the latest click, so nothing else may write `_editing`. */
let _savesOutstanding = 0;

const url = `${API_BASE}${API_MODELS_LOCAL_SETTINGS}`;
/** Long enough for a busy loopback server, short enough that a hung one ends
 *  in the unknown state while the user is still looking at the tab. */
const REQUEST_TIMEOUT_MS = 10_000;

function enqueue(task: () => Promise<void>): Promise<void> {
  const turn = _queue.then(task, task);
  _queue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

async function fetchEditing(abort?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "GET",
    signal: abort ? AbortSignal.any([abort, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`GET ${API_MODELS_LOCAL_SETTINGS} → ${res.status}`);
  const body = (await res.json()) as LocalModelSettingsResponse;
  if (typeof body.editing !== "boolean") throw new Error("malformed local-model settings");
  return body.editing;
}

/** Load the setting. Deduped while in flight. No-op while dark. */
export function loadLocalModelSettings(): Promise<void> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve();
  if (_loadInFlight) return _loadInFlight;
  _loading = true;
  const abort = new AbortController();
  _loadAbort = abort;
  _loadInFlight = enqueue(async () => {
    try {
      const editing = await fetchEditing(abort.signal);
      // A click made while this read was in flight owns the display until its
      // own answer arrives; this (older) answer must not flip the box back.
      if (_savesOutstanding === 0) {
        _editing = editing;
        _known = true;
        _loadFailed = false;
        // What the server says now supersedes whatever a past save reported.
        _saveNotice = null;
      }
    } catch (err) {
      console.warn("[models] local-model settings load failed", err);
      if (_savesOutstanding === 0) {
        // Not "keep the last value": another window or a restart may have
        // changed it, and a stale box is exactly the lie this store exists to
        // avoid.
        _known = false;
        _loadFailed = true;
      }
    } finally {
      _loading = false;
      _loadInFlight = null;
      if (_loadAbort === abort) _loadAbort = null;
    }
  });
  return _loadInFlight;
}

function noticeFor(requested: boolean, answer: LocalModelSettingsPostResponse): string | null {
  if (answer.persisted) return null;
  if (answer.editing) {
    return "This is on for now, but it could not be saved and may be off after Tandem restarts.";
  }
  return requested
    ? "This could not be switched on. It is off for now."
    : "Switched off for now, but it could not be saved and may be on again after Tandem restarts.";
}

/**
 * Switch the setting. Resolves once the store holds the server's answer. Never
 * throws. No-op while dark.
 */
export function setLocalModelEditing(value: boolean): Promise<void> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve();
  // Optimistic, synchronously in the handler: the control does not bounce.
  const before = _editing;
  _editing = value;
  _known = true;
  _saveNotice = null;
  _savesOutstanding += 1;
  // Do not wait behind a read: the click supersedes it, and its own answer
  // will say what the server holds.
  _loadAbort?.abort();
  const run = async (): Promise<void> => {
    let editing: boolean | null = null;
    let notice: string | null = null;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editing: value }),
      });
      const answer = (await res.json().catch(() => null)) as
        | (LocalModelSettingsPostResponse & { code?: string })
        | null;
      if (res.status === 403 && answer?.code === ERROR_CODE_OWN_WINDOW_ONLY) {
        // Refused: nothing reached the setting. No per-click message — the
        // Models tab says why, once, at the top. But the box must show what
        // the SERVER holds, and no value captured at click time can be
        // trusted for that (an earlier click's optimistic write may be what
        // was captured). Reads are still allowed from here, so ask; if that
        // fails too, the value is unknown, never a guess.
        noteModelsWriteRefused();
        try {
          editing = await fetchEditing();
        } catch {
          editing = null;
        }
      } else if (
        answer &&
        typeof answer.editing === "boolean" &&
        typeof answer.persisted === "boolean"
      ) {
        editing = answer.editing;
        notice = noticeFor(value, answer);
      } else {
        throw new Error(`POST ${API_MODELS_LOCAL_SETTINGS} → ${res.status}`);
      }
    } catch (err) {
      console.warn("[models] local-model settings save failed", err);
      // The request may or may not have reached the server. Ask it.
      try {
        editing = await fetchEditing();
        notice =
          editing === value ? null : "That change could not be saved. Showing the current setting.";
      } catch {
        editing = null;
        notice = "That change could not be saved, and the current setting could not be read.";
      }
    } finally {
      _savesOutstanding -= 1;
    }
    // Only the LAST click's answer reaches the display. An earlier save's
    // answer arriving while a later one is still queued is dropped: the later
    // click is what the user is looking at, and its own answer is on its way.
    if (_savesOutstanding > 0) return;
    if (editing === null) {
      _editing = before;
      _known = false;
      _loadFailed = true;
    } else {
      _editing = editing;
      _known = true;
      _loadFailed = false;
    }
    _saveNotice = notice;
  };
  return enqueue(run);
}

export interface LocalModelSettingsState {
  /** The server's value, meaningful only while `known`. */
  readonly editing: boolean;
  /** Has a load or a save told us the server's value? */
  readonly known: boolean;
  /** A read is in flight. The tab shows "Checking…" rather than a value that
   *  another window or a restart may have changed. */
  readonly loading: boolean;
  readonly loadFailed: boolean;
  /** A save that did not fully land, in words; null otherwise. */
  readonly saveNotice: string | null;
  load: () => Promise<void>;
  setEditing: (value: boolean) => Promise<void>;
}

export function createLocalModelSettings(): LocalModelSettingsState {
  return {
    get editing() {
      return _editing;
    },
    get known() {
      return _known;
    },
    get loading() {
      return _loading;
    },
    get loadFailed() {
      return _loadFailed;
    },
    get saveNotice() {
      return _saveNotice;
    },
    load: loadLocalModelSettings,
    setEditing: setLocalModelEditing,
  };
}

/** Test seam — reset the module singleton. */
export function _resetLocalModelSettingsForTests(): void {
  _editing = false;
  _known = false;
  _loading = false;
  _loadFailed = false;
  _saveNotice = null;
  _loadInFlight = null;
  _loadAbort = null;
  _queue = Promise.resolve();
  _savesOutstanding = 0;
}
