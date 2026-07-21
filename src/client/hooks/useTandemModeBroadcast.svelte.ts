import * as Y from "yjs";
import { API_MODE_RELEASE } from "../../shared/api-paths.js";
import {
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { TandemMode } from "../../shared/types.js";
import { TandemModeSchema } from "../../shared/types.js";
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
      const prev = tandemMode;
      tandemMode = mode;
      // WS-A2: leaving Solo releases everything held while in Solo.
      if (shouldReleaseSolo(prev, mode)) {
        void triggerSoloRelease();
      }
    },
  };
}
