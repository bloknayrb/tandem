import type { AiLiveIndicator, AiReadinessState } from "../hooks/useAiReadiness.svelte";

/**
 * Consolidated AI-status indicator for the status pill (replaces the old
 * titlebar "AI connected" pill + the status bar's "Assistant · idle" segment).
 *
 * This pure mapping is the spec: given the readiness `state`, the affirmative
 * `liveIndicator`, and whether the user is in Solo mode, decide what the single
 * status-pill indicator renders. Extracted (not inlined) so the multi-state
 * logic — especially the ordering rules below — is unit-tested, not mounted.
 *
 * Ordering rules (order is load-bearing):
 *   1. A present `liveIndicator` ("connected"/"solo-paused") is a PROVEN-connected
 *      fact — `mcpSessionActive`, an actual MCP `initialize` round-trip — and is
 *      independent of both document-sync connectivity and launcher status. So it
 *      OUTRANKS the booting gate. Gating it on `state` would blank a genuinely
 *      connected AI during a doc-sync blip, or mask a live *manually-launched*
 *      session when the launcher route never settles (#1054) — exactly the case
 *      the old titlebar pill (which rendered purely off `liveIndicator`) handled.
 *   2. Only the NEGATIVE / absent states are gated on `booting`, so we never flash
 *      "AI not connected" before readiness settles. `state === "ready"` with no
 *      session is the launcher's running-but-no-session startup window → render
 *      nothing (don't alarm). In Solo with no session we suppress entirely,
 *      mirroring `useAiReadiness`'s deliberate Solo `chip` silence — the user
 *      opted out of AI, so nagging them to connect contradicts that intent.
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
  /** Hover tooltip — carries the explanation the terse label omits. */
  title: string;
  /** Screen-reader label (the visible text under-specifies "Solo · edits held"). */
  ariaLabel: string;
}

const CONNECTED: AiIndicatorView = {
  label: "AI connected",
  tone: "connected",
  dataState: "connected",
  canAnimate: true,
  title: "Claude is connected — it can see your selections, comments, and edits",
  ariaLabel: "Claude is connected and receiving your work",
};

const SOLO_PAUSED: AiIndicatorView = {
  label: "Solo · edits held",
  tone: "solo",
  dataState: "solo-paused",
  canAnimate: true,
  title:
    "Solo mode — the AI won't see your edits or comments (chat still works). Switch to Tandem to share them.",
  ariaLabel: "Solo mode — the AI is connected but won't see your edits until you switch to Tandem",
};

const NOT_CONNECTED: AiIndicatorView = {
  label: "AI not connected",
  tone: "not-connected",
  dataState: "not-connected",
  canAnimate: false,
  title: "No AI is connected. Start Claude Code and run /mcp to connect.",
  ariaLabel: "No AI is connected",
};

/**
 * Returns the indicator view, or `null` to render nothing (booting with no live
 * session, the running-but-no-session startup window, or Solo-with-no-session).
 */
export function aiIndicatorView(
  state: AiReadinessState,
  liveIndicator: AiLiveIndicator,
  soloMode: boolean,
): AiIndicatorView | null {
  // Rule 1: a proven-connected session outranks everything (incl. booting).
  if (liveIndicator === "connected") return CONNECTED;
  if (liveIndicator === "solo-paused") return SOLO_PAUSED;

  // liveIndicator === null below (no MCP session open).
  // Rule 2: gate the negative/absent states so we never flash "not connected".
  if (state === "booting") return null; // readiness not settled — don't flash
  if (state === "ready") return null; // launcher running, no session yet
  if (soloMode) return null; // opted out of AI — don't nag
  return NOT_CONNECTED; // unconfigured / stopped, Tandem: honest "not connected"
}
