/**
 * AI-readiness reader (#1018/#1022).
 *
 * "AI" in Tandem today is the external Claude Code integration, spawned and
 * supervised by the launcher. Whether AI actually works is therefore the
 * launcher's `GET /api/launcher/status` truth — NOT the document-sync
 * connection (the green "Synced" dot) and NOT `claudeActive` (which is
 * Claude's *activity* presence: it flaps to `false` every few seconds when
 * Claude is idle between tool calls, so gating a setup CTA on it would make a
 * working user's chip oscillate). `claudeActive` stays the idle/working
 * animation on the status dot; readiness keys on launcher status.
 *
 * States:
 *   - `booting`      — not yet known (still connecting / first status read
 *                      pending). Render nothing; never flash a CTA on boot.
 *   - `unconfigured` — launcher unavailable (`available: false`: stdio mode,
 *                      disabled, or no claude-code integration). Prompt setup.
 *   - `stopped`      — configured but not running (`available: true,
 *                      running: false` — crashed/stopped). Prompt restart, NOT
 *                      the setup wizard (the user is already set up).
 *   - `ready`        — Claude Code running.
 *
 * `shouldPrompt` folds in Solo-mode suppression: in Solo mode the user has
 * deliberately chosen to work without AI surfacing, so a persistent "Connect
 * AI" nag would contradict that intent.
 *
 * Fail-safe: a transient status-fetch failure (network blip, non-OK) keeps the
 * PRIOR status rather than clobbering to "unconfigured" — mirroring
 * `useFirstRunNeeded`'s "don't assert a scary state on a hiccup" discipline.
 */
import { onDestroy } from "svelte";
import { API_LAUNCHER_STATUS } from "../../shared/api-paths.js";
import type { LauncherStatus } from "../../shared/launcher/contract.js";
import { API_BASE } from "../utils/fileUpload.js";

export type AiReadinessState = "booting" | "unconfigured" | "stopped" | "ready";

/** What the titlebar/empty-state CTA should offer, or `null` to show nothing. */
export type AiChip = "connect" | "restart" | null;

export interface AiReadiness {
  readonly state: AiReadinessState;
  /** The CTA to surface, with Solo-mode suppression already applied. */
  readonly chip: AiChip;
  /** Re-poll launcher status now (e.g. just after triggering a restart). */
  refresh: () => void;
}

const POLL_MS = 8_000;

export function createAiReadiness(deps: {
  connected: () => boolean;
  firstRunSettled: () => boolean;
  soloMode: () => boolean;
}): AiReadiness {
  let status = $state<LauncherStatus | null>(null);
  // Have we ever read status successfully? Distinguishes "still booting" from
  // a genuine `available: false`, so the chip never flashes during cold start.
  let settledOnce = $state(false);

  // Drop stale async resolves (a poll that resolves after the component is
  // gone, or after a newer poll superseded it). Mirrors useFirstRunNeeded's gen.
  let gen = 0;

  async function poll(): Promise<void> {
    const mine = ++gen;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${API_LAUNCHER_STATUS}`);
    } catch {
      return; // network blip — keep prior status (fail-safe)
    }
    if (mine !== gen) return;
    if (!res.ok) return; // transient server error — keep prior status
    try {
      status = (await res.json()) as LauncherStatus;
      settledOnce = true;
    } catch {
      // malformed body — keep prior status
    }
  }

  void poll();
  const interval = setInterval(() => void poll(), POLL_MS);
  onDestroy(() => {
    gen++;
    clearInterval(interval);
  });

  const state = $derived.by((): AiReadinessState => {
    if (!deps.firstRunSettled() || !deps.connected() || !settledOnce || status === null) {
      return "booting";
    }
    if (status.available === false) return "unconfigured";
    return status.running === true ? "ready" : "stopped";
  });

  const chip = $derived.by((): AiChip => {
    if (deps.soloMode()) return null;
    if (state === "unconfigured") return "connect";
    if (state === "stopped") return "restart";
    return null;
  });

  return {
    get state() {
      return state;
    },
    get chip() {
      return chip;
    },
    refresh: () => void poll(),
  };
}
