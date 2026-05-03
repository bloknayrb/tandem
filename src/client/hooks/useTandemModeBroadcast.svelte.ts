import * as Y from "yjs";
import {
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { TandemMode } from "../../shared/types.js";
import { TandemModeSchema } from "../../shared/types.js";

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
): TandemModeBroadcastState {
  let tandemMode = $state<TandemMode>(
    (() => {
      try {
        const saved = localStorage.getItem(TANDEM_MODE_KEY);
        const parsed = TandemModeSchema.safeParse(saved);
        return parsed.success ? parsed.data : TANDEM_MODE_DEFAULT;
      } catch (err) {
        console.warn(`[tandem] localStorage unavailable reading ${TANDEM_MODE_KEY}:`, err);
        return TANDEM_MODE_DEFAULT;
      }
    })(),
  );

  // Persist tandem mode to localStorage
  $effect(() => {
    const mode = tandemMode;
    try {
      localStorage.setItem(TANDEM_MODE_KEY, mode);
    } catch (err) {
      console.warn(`[tandem] failed to persist ${TANDEM_MODE_KEY}:`, err);
    }
  });

  // Broadcast tandem mode to CTRL_ROOM Y.Map
  $effect(() => {
    const bootstrapYdoc = getBootstrapYdoc();
    const mode = tandemMode;
    if (!bootstrapYdoc) return;
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      awareness.set(Y_MAP_MODE, mode);
    } catch (err) {
      console.warn("[tandem] failed to broadcast tandem mode to Y.Map:", err);
    }
  });

  // Broadcast selection dwell time to CTRL_ROOM
  $effect(() => {
    const bootstrapYdoc = getBootstrapYdoc();
    const dwellMs = getSelectionDwellMs();
    if (!bootstrapYdoc) return;
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      awareness.set(Y_MAP_DWELL_MS, dwellMs);
    } catch (err) {
      console.warn("[tandem] failed to broadcast dwell ms to Y.Map:", err);
    }
  });

  return {
    get tandemMode() {
      return tandemMode;
    },
    setTandemMode(mode: TandemMode) {
      tandemMode = mode;
    },
  };
}
