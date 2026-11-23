/**
 * Observer for CTRL_ROOM's mode key, for the mode-unknown re-ask (#2358, the
 * restart question; ADR-054's mode-unknown observer amendment).
 *
 * Reports the mode it reads (`readModeState()`) at install and at every change
 * of `Y_MAP_MODE`, and nothing else: what to do with it is `note`'s
 * (`noteModeObserved` in `sessions/ownership.ts`, which does nothing while
 * ownership is off). Installed by `attachCtrlObservers` beside the chat, meta
 * and provenance observers, so the Hocuspocus document swap re-installs it
 * (`reattachCtrlObservers`); the report at install is what lets a swap that
 * copied a mode in carry it on. Only reads; writes nothing.
 */

import type * as Y from "yjs";
import { Y_MAP_MODE, Y_MAP_USER_AWARENESS } from "../../../shared/constants.js";
import { type ModeState, readModeState } from "../../mode.js";

export function makeModeKnownObserver(deps: {
  ctrlDoc: Y.Doc;
  note: (state: ModeState) => void;
}): () => void {
  const awareness = deps.ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
  deps.note(readModeState());
  const onChange = (event: Y.YMapEvent<unknown>): void => {
    if (event.keysChanged.has(Y_MAP_MODE)) deps.note(readModeState());
  };
  awareness.observe(onChange);
  return () => awareness.unobserve(onChange);
}
