import { useEffect, useState } from "react";
import * as Y from "yjs";
import {
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants";
import type { TandemMode } from "../../shared/types";
import { TandemModeSchema } from "../../shared/types";

interface TandemModeBroadcastResult {
  tandemMode: TandemMode;
  setTandemMode: (mode: TandemMode) => void;
}

/**
 * Manages tandem mode state: persists to localStorage, and broadcasts both
 * `Y_MAP_MODE` and `Y_MAP_DWELL_MS` to the CTRL_ROOM Y.Map so the server
 * (and Claude) can see the current settings.
 *
 * @param bootstrapYdoc  The CTRL_ROOM Y.Doc from useYjsSync (may be null before ready).
 * @param selectionDwellMs  The user's configured selection dwell time (from useTandemSettings).
 */
export function useTandemModeBroadcast(
  bootstrapYdoc: Y.Doc | null,
  selectionDwellMs: number,
): TandemModeBroadcastResult {
  const [tandemMode, setTandemMode] = useState<TandemMode>(() => {
    try {
      const saved = localStorage.getItem(TANDEM_MODE_KEY);
      const parsed = TandemModeSchema.safeParse(saved);
      return parsed.success ? parsed.data : TANDEM_MODE_DEFAULT;
    } catch (err) {
      console.warn(`[tandem] localStorage unavailable reading ${TANDEM_MODE_KEY}:`, err);
      return TANDEM_MODE_DEFAULT;
    }
  });

  // Persist tandem mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(TANDEM_MODE_KEY, tandemMode);
    } catch (err) {
      console.warn(`[tandem] failed to persist ${TANDEM_MODE_KEY}:`, err);
    }
  }, [tandemMode]);

  // Broadcast tandem mode to CTRL_ROOM Y.Map so the server (and Claude) can see it
  useEffect(() => {
    if (!bootstrapYdoc) return;
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      awareness.set(Y_MAP_MODE, tandemMode);
    } catch (err) {
      console.warn("[tandem] failed to broadcast tandem mode to Y.Map:", err);
    }
  }, [tandemMode, bootstrapYdoc]);

  // Broadcast selection dwell time to CTRL_ROOM so the server uses the user's setting
  useEffect(() => {
    if (!bootstrapYdoc) return;
    try {
      const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
      awareness.set(Y_MAP_DWELL_MS, selectionDwellMs);
    } catch (err) {
      console.warn("[tandem] failed to broadcast dwell ms to Y.Map:", err);
    }
  }, [selectionDwellMs, bootstrapYdoc]);

  return { tandemMode, setTandemMode };
}
