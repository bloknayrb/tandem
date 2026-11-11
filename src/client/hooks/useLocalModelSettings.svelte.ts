import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import {
  API_MODELS_LOCAL_SETTINGS,
  type LocalModelSettingsPostResponse,
  type LocalModelSettingsResponse,
} from "../../shared/models/contract.js";
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
 *  - `known` is false until a load or a save has told us the server's value. The
 *    tab then shows no checkbox at all, only Retry and an explicit "Switch off",
 *    because an unticked box would claim "off" and could only be clicked to On;
 *  - requests are serialized, and a load that started before a save cannot
 *    overwrite what the save learned.
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
/** Bumped by every save, so a load that began earlier is discarded. */
let _saveGeneration = 0;
let _saveQueue: Promise<void> = Promise.resolve();

const url = `${API_BASE}${API_MODELS_LOCAL_SETTINGS}`;

async function fetchEditing(): Promise<boolean> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`GET ${API_MODELS_LOCAL_SETTINGS} → ${res.status}`);
  const body = (await res.json()) as LocalModelSettingsResponse;
  if (typeof body.editing !== "boolean") throw new Error("malformed local-model settings");
  return body.editing;
}

/** Load the setting. Deduped while in flight. No-op while dark. */
export function loadLocalModelSettings(): Promise<void> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve();
  if (_loadInFlight) return _loadInFlight;
  const generation = _saveGeneration;
  _loading = true;
  _loadInFlight = (async () => {
    try {
      const editing = await fetchEditing();
      if (generation !== _saveGeneration) return; // a save has newer knowledge
      _editing = editing;
      _known = true;
      _loadFailed = false;
    } catch (err) {
      console.warn("[models] local-model settings load failed", err);
      if (generation === _saveGeneration) _loadFailed = true;
    } finally {
      _loading = false;
      _loadInFlight = null;
    }
  })();
  return _loadInFlight;
}

function noticeFor(requested: boolean, answer: LocalModelSettingsPostResponse): string | null {
  if (answer.persisted) return null;
  if (answer.editing) {
    return "This is on for now, but it could not be saved and may be off after Tandem restarts.";
  }
  return requested
    ? "This could not be saved, so it stays off."
    : "Switched off for now, but it could not be saved and may be on again after Tandem restarts.";
}

/**
 * Switch the setting. Resolves once the store holds the server's answer. Never
 * throws. No-op while dark.
 */
export function setLocalModelEditing(value: boolean): Promise<void> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve();
  _saveGeneration += 1;
  // Optimistic, synchronously in the handler: the control does not bounce.
  const before = { editing: _editing, known: _known };
  _editing = value;
  _known = true;
  _saveNotice = null;
  const run = async (): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editing: value }),
      });
      const answer = (await res.json().catch(() => null)) as LocalModelSettingsPostResponse | null;
      if (answer && typeof answer.editing === "boolean" && typeof answer.persisted === "boolean") {
        _editing = answer.editing;
        _known = true;
        _loadFailed = false;
        _saveNotice = noticeFor(value, answer);
        return;
      }
      throw new Error(`POST ${API_MODELS_LOCAL_SETTINGS} → ${res.status}`);
    } catch (err) {
      console.warn("[models] local-model settings save failed", err);
      // The request may or may not have reached the server. Ask it.
      try {
        _editing = await fetchEditing();
        _known = true;
        _loadFailed = false;
        _saveNotice =
          _editing === value
            ? null
            : "That change could not be saved. Showing the current setting.";
      } catch {
        _editing = before.editing;
        _known = false;
        _loadFailed = true;
        _saveNotice = "That change could not be saved, and the current setting could not be read.";
      }
    }
  };
  const turn = _saveQueue.then(run, run);
  _saveQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export interface LocalModelSettingsState {
  /** The server's value, meaningful only while `known`. */
  readonly editing: boolean;
  /** Has a load or a save told us the server's value? */
  readonly known: boolean;
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
  _saveGeneration = 0;
  _saveQueue = Promise.resolve();
}
