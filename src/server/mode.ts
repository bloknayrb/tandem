import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants.js";
import { TandemModeSchema } from "../shared/types.js";
import { getOrCreateDocument } from "./yjs/provider.js";

/**
 * WS-A2 Solo defer-and-release. This module is the SINGLE server-authoritative
 * source of "what mode are we in, and should the AI see this record?" — the
 * privacy hold is enforced by reading live mode here at each of the four
 * delivery surfaces, NOT by trusting a client-set flag.
 *
 * IMPORTANT: this file must NOT import `local-model/collaborator.ts` (the gated
 * sole importer of the local-model engine). The canonical mode read used to
 * live there (`readMode`); it is lifted here so the event path can read mode
 * without dragging the BYO-models coupling across the whole codebase.
 *
 * The read is a synchronous cross-doc Y.Map access of CTRL_ROOM — swap-proof
 * (each call re-fetches the doc via `getOrCreateDocument`, never closing over a
 * swapped-out CTRL_ROOM), and safe to call from inside another doc's
 * transaction (it is a read, never a write).
 */

/** The mode as stored, distinguishing genuine absence ("indeterminate") from
 * a present value. Absence happens when the CTRL_ROOM session was lost/corrupt
 * on restart — the fail-CLOSED case (WS-A2): we must NOT default an
 * indeterminate mode to "tandem" and surface previously-held items. A
 * present-but-garbage value still collapses to the default ("tandem"). */
export type ModeState = "solo" | "tandem" | "indeterminate";

/** Hoisted so the per-call `.catch(...)` wrapper isn't re-allocated on every
 * `readModeState()` — this is the shared read on the `pushEvent` fan-out gate. */
const MODE_PARSER = TandemModeSchema.catch(TANDEM_MODE_DEFAULT);

/** Three-state live mode read used for HIDE enforcement. Only genuine absence
 * of the mode key is "indeterminate"; a malformed value uses the schema's
 * `.catch` default. */
export function readModeState(): ModeState {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
  const raw = awareness.get(Y_MAP_MODE);
  if (raw === undefined) return "indeterminate";
  return MODE_PARSER.parse(raw);
}

/** Collapse the three-state enforcement mode to the two-state USER-FACING value:
 * indeterminate reports as the default. The single home for this collapse rule,
 * shared by `readLiveMode` and any surface that already holds a `ModeState` and
 * only needs the reported value (e.g. `checkInbox.mode`). */
export function reportedMode(state: ModeState): "solo" | "tandem" {
  return state === "indeterminate" ? TANDEM_MODE_DEFAULT : state;
}

/** Two-state read for the USER-FACING reported mode (e.g. `checkInbox.mode`,
 * `/api/mode`, and the collaborator's own gate). Behaviourally identical to the
 * pre-WS-A2 `readMode()`: indeterminate collapses to the default. Enforcement
 * paths use `readModeState()`; only what we *report* uses this. */
export function readLiveMode(): "solo" | "tandem" {
  return reportedMode(readModeState());
}

/**
 * The single Solo-hold predicate, evaluated at all four delivery surfaces.
 * Carries ONLY the Solo-hold — ADR-027 note/reply privacy stays in the existing
 * per-surface type gates (comment-only at the push/checkInbox surfaces,
 * `channelVisibleReplies` for replies), which must not be folded in here.
 *
 * - solo: hide every user-authored record (server-authoritative — independent
 *   of the client `heldInSolo` marker, so a promotion or a creation-race can't
 *   leak).
 * - indeterminate (restart, mode lost): fail CLOSED — hide exactly the records
 *   that carry the persisted `heldInSolo` marker, so previously-held items stay
 *   held until an explicit release, while everything else surfaces normally.
 * - tandem: hide nothing.
 */
export function hideFromAI(
  record: { author: string; heldInSolo?: boolean },
  modeState: ModeState,
): boolean {
  if (modeState === "solo") return record.author === "user";
  if (modeState === "indeterminate") return record.heldInSolo === true;
  return false;
}
