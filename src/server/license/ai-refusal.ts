/**
 * The single licence decision for Tandem's AI surfaces (#1521, ADR-040 as
 * amended 2026-10-11): "after the 14 day trial, tandem remains a usable editor,
 * but with no AI features".
 *
 * Every admission point — the `/mcp` transport, Claude's chat writes, push and
 * wake, the launcher's spawn, the local-model loop — asks this one function and
 * does nothing else with licence state. The editor itself is never refused.
 *
 * **No memo.** `resolveLicenseState` records that a cache caused the
 * mid-session-expiry bugs, so this re-reads disk on every call: two small
 * `readFileSync` and at most one Ed25519 verify — sub-millisecond, paid per MCP
 * POST and per pushed event.
 */
import type { Response } from "express";
import {
  AI_REFUSAL_STATE_UNREADABLE_MESSAGE,
  AI_REFUSAL_UNLICENSED_MESSAGE,
  type AiRefusalKind,
  aiRefusalUnverifiableMessage,
  LICENSE_REQUIRED,
} from "../../shared/license-copy.js";
import { GATE_ENABLED } from "./gate-flag.js";
import { resolveLiveLicenseState } from "./license-state.js";
import type { LicenseState } from "./license-types.js";

/** The refusal envelope. It is also the `/api` 403 body, verbatim. */
export interface AiRefusal {
  error: typeof LICENSE_REQUIRED;
  kind: AiRefusalKind;
  message: string;
}

/**
 * Pure decision over a resolved state. `null` admits.
 *
 * `restricted` is the only refusing status (the literal is not renamed —
 * ADR-040 decision 5). `grace` (#2231) admits by design: a licence that fails
 * its check keeps the AI on for its grace period, and nothing here changes. `kind: "unverifiable"` when a licence file is present
 * but fails to verify; its message never carries the purchase URL. (The same
 * kind also covers `aiRefusal()`'s fail-closed catch, with licence-neutral copy.)
 */
export function aiRefusalFor(state: LicenseState): AiRefusal | null {
  if (!state.gateActive) return null;
  if (state.status !== "restricted") return null;
  if (state.licenseUnverifiable !== undefined) {
    return {
      error: LICENSE_REQUIRED,
      kind: "unverifiable",
      message: aiRefusalUnverifiableMessage(state.licenseUnverifiable),
    };
  }
  return { error: LICENSE_REQUIRED, kind: "unlicensed", message: AI_REFUSAL_UNLICENSED_MESSAGE };
}

let loggedResolveFailure = false;

/**
 * Live decision. Returns `null` on its first line while the gate ships dark, so
 * a dark build admits everywhere without touching disk.
 *
 * Total: it runs unguarded inside `pushEvent` and above every `/mcp` dispatch,
 * so a throw from resolving (a hand-edited `trial.json` near the maximum Date
 * makes `toISOString()` throw) would break event delivery outright. It fails
 * CLOSED, as unverifiable, which never carries the purchase URL. The copy is
 * licence-neutral (#2206): a throw here says nothing about whether a licence
 * exists, so it must not claim one is installed.
 */
export function aiRefusal(): AiRefusal | null {
  if (!GATE_ENABLED) return null;
  try {
    return aiRefusalFor(resolveLiveLicenseState());
  } catch (err) {
    if (!loggedResolveFailure) {
      loggedResolveFailure = true;
      console.error("[License] Could not resolve licence state; refusing AI:", err);
    }
    return {
      error: LICENSE_REQUIRED,
      kind: "unverifiable",
      message: AI_REFUSAL_STATE_UNREADABLE_MESSAGE,
    };
  }
}

/**
 * Answer an HTTP request with the refusal: 403 and the envelope as the body,
 * plus any route-specific fields (the launcher adds its own `code`). The one
 * shape every `/api` refusal and the `GET /mcp` refusal share. (The wake
 * socket refuses before Express exists, so it writes its own raw 403.)
 */
export function sendAiRefusal(
  res: Response,
  refusal: AiRefusal,
  extra: Record<string, unknown> = {},
): void {
  // `extra` first: a route may add fields, never overwrite the envelope's.
  res.status(403).json({ ...extra, ...refusal });
}
