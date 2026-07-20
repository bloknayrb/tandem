import type { AiLiveIndicator, AiReadinessState } from "../hooks/useAiReadiness.svelte";

/**
 * Consolidated AI-status indicator for the status pill (replaces the old
 * titlebar "AI connected" pill + the status bar's "Assistant · idle" segment).
 *
 * This pure mapping is the spec: given the readiness `state`, the affirmative
 * `liveIndicator`, and whether the user is in Solo mode, decide what the single
 * status-pill indicator renders. Extracted (not inlined) so the multi-state
 * logic — especially the two false-negatives the plan review caught — is
 * unit-tested rather than mounted.
 *
 * The two subtle rules the review forced:
 *   1. `state === "ready"` with NO session (`liveIndicator === null`) is the
 *      launcher's "running but no MCP transport open yet" startup window. The
 *      launcher is truthfully running, so we render NOTHING — never a false
 *      "AI not connected" alarm. Only the genuinely-down states
 *      (`unconfigured`/`stopped`) surface "AI not connected".
 *   2. In Solo mode with no session we SUPPRESS "AI not connected" entirely,
 *      mirroring `useAiReadiness`'s deliberate Solo `chip` silence — the user
 *      opted out of AI, so nagging them to connect contradicts that intent.
 *      ("Solo · edits held" still shows whenever a session IS open.)
 */
export type AiIndicatorTone = "connected" | "solo" | "not-connected";

export interface AiIndicatorView {
  /** User-facing label. */
  label: string;
  /** Drives dot + text color. */
  tone: AiIndicatorTone;
  /** `data-ai-state` attribute (kept in sync with the old titlebar values). */
  dataState: "connected" | "solo-paused" | "not-connected";
  /**
   * Whether this state may animate its dot when Claude is actively working.
   * Only ever true when a session is live (connected/solo) — a disconnected
   * indicator must never pulse "as if working" (an incoherent micro-state).
   */
  canAnimate: boolean;
}

/**
 * Returns the indicator view, or `null` to render nothing (booting, the
 * running-but-no-session startup window, or Solo-with-no-session).
 */
export function aiIndicatorView(
  state: AiReadinessState,
  liveIndicator: AiLiveIndicator,
  soloMode: boolean,
): AiIndicatorView | null {
  // Never flash a state on boot (also covers document-sync blips, which flip
  // `state` back to "booting" via the hook's `deps.connected()` gate).
  if (state === "booting") return null;

  if (liveIndicator === "connected") {
    return { label: "AI connected", tone: "connected", dataState: "connected", canAnimate: true };
  }
  if (liveIndicator === "solo-paused") {
    return { label: "Solo · edits held", tone: "solo", dataState: "solo-paused", canAnimate: true };
  }

  // liveIndicator === null below (no MCP session open).
  // `ready` here = launcher running but no session yet — don't alarm.
  if (state === "ready") return null;

  // `unconfigured` / `stopped`: genuinely no AI. Suppress in Solo (the user
  // opted out); surface the honest "not connected" only in Tandem.
  if (soloMode) return null;
  return {
    label: "AI not connected",
    tone: "not-connected",
    dataState: "not-connected",
    canAnimate: false,
  };
}
