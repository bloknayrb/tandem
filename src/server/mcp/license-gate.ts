/**
 * Surface B of the license gate (#1116, ADR-040): block Claude's document- and
 * annotation-mutation MCP tools when the on-device license state is `restricted`
 * (trial expired, no license). Read-only / inspection tools are never gated —
 * the escape hatch is that you can always open, read, and export your work.
 *
 * The gate is a pure, synchronous pre-check with ZERO Y.Doc access: it re-reads
 * license state from disk per dispatch (no cache, so an activation elsewhere
 * takes effect on the next call) and returns an `mcpError` envelope before the
 * wrapped handler — and thus before any document write or typing-presence
 * broadcast — ever runs.
 */
import type { NextFunction, Request, Response } from "express";
import { resolveLiveLicenseState } from "../license/license-state.js";
import type { LicenseState } from "../license/license-types.js";
import { mcpError, withErrorBoundary } from "./response.js";

type McpToolResult = ReturnType<typeof mcpError>;

/** Shared user-facing copy for both the MCP envelope and the HTTP 403 body. */
export const RESTRICTED_MESSAGE =
  "Your Tandem trial has ended. Activate a license to keep editing — your documents stay open for reading and export.";

/**
 * Pure gate decision. Given a resolved license state, return an `mcpError`
 * envelope when a mutation must be blocked, or `null` when the call may proceed.
 * `restricted` blocks; `trial` and `licensed` pass; an inactive gate (dark
 * build, or no trial clock yet) is always a no-op. Exported for direct testing
 * without touching the filesystem or the build-time flag.
 */
export function licenseGateResult(state: LicenseState): McpToolResult | null {
  if (!state.gateActive) return null;
  if (state.status === "restricted") {
    return mcpError("LICENSE_REQUIRED", RESTRICTED_MESSAGE);
  }
  return null;
}

/**
 * Live gate check: re-resolve license state from disk and apply
 * `licenseGateResult`. Synchronous — `resolveLicenseState` reads files with
 * `readFileSync` and performs at most one Ed25519 verify.
 */
export function licenseGate(): McpToolResult | null {
  return licenseGateResult(resolveLiveLicenseState());
}

/**
 * Registration-time wrapper for Claude's mutation tools. Drop-in replacement for
 * `withErrorBoundary` at a tool's `server.tool(...)` registration: it runs the
 * license pre-check FIRST, then the same try/catch error boundary. Using this at
 * the registration site (rather than a manual check inside each handler) means a
 * gated tool can't ship with the check forgotten in one code path.
 */
export function gatedTool<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: (args: TArgs) => Promise<McpToolResult>,
): (args: TArgs) => Promise<McpToolResult> {
  return withErrorBoundary(toolName, async (args: TArgs) => {
    const blocked = licenseGate();
    if (blocked) return blocked;
    return handler(args);
  });
}

/** Send the HTTP 403 LICENSE_REQUIRED envelope (same shape as other /api errors). */
export function sendLicenseRequired(res: Response): void {
  res.status(403).json({ error: "LICENSE_REQUIRED", message: RESTRICTED_MESSAGE });
}

/**
 * Express middleware twin of `gatedTool` for the mutating `/api` routes that
 * bypass Surface A (they write to the Y.Doc over HTTP, not the Hocuspocus
 * socket). Place it AFTER the auth/CORS middleware and BEFORE the body parser
 * so a restricted caller is rejected without parsing a payload. No-op unless
 * restricted (and always a no-op when the gate is dark).
 */
export function licenseGateMiddleware(_req: Request, res: Response, next: NextFunction): void {
  // Same decision primitive as `gatedTool` (the MCP twin): `licenseGate()` returns
  // the block envelope when restricted, null otherwise. The middleware discards the
  // MCP envelope and renders the HTTP 403 instead — one policy, two transports.
  if (licenseGate() !== null) {
    sendLicenseRequired(res);
    return;
  }
  next();
}
