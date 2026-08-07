import type { AiChip, AiLiveIndicator, AiReadinessState } from "../hooks/useAiReadiness.svelte";
import type { CwdDrift } from "../hooks/useCwdDrift.svelte";

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
  // Scoped to what `liveIndicator` actually proves: an MCP session exists, so
  // Claude can READ the document when it asks. Whether Claude is notified the
  // moment you comment is the separate push path, which this indicator has no
  // signal for — see docs/troubleshooting.md. The previous copy ("receiving your
  // work" / "it can see your … comments") asserted exactly that missing half, and
  // was false for the pull-only session this release exists to make legible.
  title: "Claude is connected and can read your document",
  ariaLabel: "Claude is connected and can read your document",
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

// --- Working-directory drift qualifier (#1282) -----------------------------

export interface CwdDriftPill {
  /** Compact status-bar text. */
  label: string;
  /** Hover tooltip. */
  title: string;
  /** Screen-reader label — carries the full paths, which the pill elides. */
  ariaLabel: string;
  /** Menu heading: the explanation the pill has no room for. */
  explanation: string;
  /** Label for the act-on-it row. */
  actionLabel: string;
}

/**
 * The working-directory drift pill, or `null` to render nothing.
 *
 * **Why this is a sibling of the AI indicator and not folded into it.** The
 * obvious placement — inside `aiIndicatorView`'s returned view — is dead code
 * in exactly the state the nudge exists for: `aiIndicatorView` returns `null`
 * when `state === "ready"` with no live MCP session, which is precisely the
 * auto-launched desktop startup window where the launcher is running (and so
 * has a cwd to be wrong about) but no agent has connected yet. Anything nested
 * inside `{#if aiView}` would never render there.
 *
 * **Why two adjacent Claude chips is not the #1268 shape.** That failure was two
 * CTAs for the same situation, describing it differently and wired to different
 * handlers. These two cannot coexist by construction: `aiChip` is non-null only
 * for `unconfigured` / `stopped`, both of which mean the supervised launcher is
 * not running — and the server reports drift only when it IS. They can overlap
 * only transiently, when Claude dies between a drift probe and the next
 * readiness poll, so `aiChip` wins outright. This is a staleness gate, not a
 * second copy of the server's predicate: it never turns a `false` into a `true`.
 *
 * `drift` being non-null already means "the server says nudge"; suppression the
 * USER asked for (per-pair dismissal, session backstop, permanent opt-out) is
 * applied by the caller before this point, so it stays in one place —
 * `cwdDriftDismiss` — rather than half here and half there.
 */
export function cwdDriftPill(drift: CwdDrift | null, aiChip: AiChip): CwdDriftPill | null {
  if (drift === null) return null;
  if (aiChip !== null) return null;
  // Names the consequence, not the state. "AI · other folder" reads as a
  // connection status and leaves the user with no idea what is actually
  // degraded — the document syncs fine and Claude can still edit it; what it
  // cannot see is everything AROUND the document.
  const consequence =
    `Claude is running in ${drift.claudeCwd}, not ${drift.suggestedCwd}. ` +
    "It can still read and edit this document, but it can't see that folder's " +
    "CLAUDE.md, .claude/ settings or git history, and its own file tools can't " +
    "reach the files beside it.";
  return {
    label: `Claude in ${drift.claudeLabel}`,
    title: consequence,
    ariaLabel: `Working folder mismatch. ${consequence}`,
    explanation: consequence,
    actionLabel: `Restart Claude in ${drift.label}…`,
  };
}
