/**
 * The Codex approval wire contract.
 *
 * Both ends of the worker<->server boundary need the same answer to two
 * questions — which JSON-RPC methods are approval requests, and what result
 * shape answers each one — because they sit at opposite ends of a single
 * exchange: this worker receives the app-server's request and writes the reply,
 * while `src/server/codex/approval-broker.ts` decides what that reply says.
 *
 * Held as two copies they could disagree without anything failing loudly. The
 * broker would accept a method the worker auto-declines (the human is asked, and
 * the answer is thrown away), or encode a decision in the modern `decision`
 * shape for an app-server that only understands the legacy `approved` /
 * `denied` one — a decline that reads as a malformed response, or worse, an
 * approval that doesn't land.
 *
 * Deliberately import-free, so the server bundle pays nothing for importing a
 * module that physically lives in the worker's directory. It belongs under
 * `src/shared/`; it lives here only until that tree settles.
 */

/**
 * Every JSON-RPC method Tandem is willing to put in front of a human.
 *
 * The `item/` pair is the current app-server protocol; `execCommandApproval` /
 * `applyPatchApproval` are the legacy pair, still emitted by older Codex CLIs.
 * Anything not listed here is answered fail-closed without asking.
 */
export const CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

export type CodexApprovalMethod = (typeof CODEX_APPROVAL_METHODS)[number];

export function isCodexApprovalMethod(method: string): method is CodexApprovalMethod {
  return (CODEX_APPROVAL_METHODS as readonly string[]).includes(method);
}

/** Approvals that touch the filesystem rather than spawning a process. */
export function isCodexFileChangeMethod(method: string): boolean {
  return method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
}

/** Methods whose result uses the pre-`item/` encoding. */
export function isLegacyCodexApprovalMethod(method: string): boolean {
  return method === "execCommandApproval" || method === "applyPatchApproval";
}

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline";

/** Shown to Codex when a human declined. */
export const DECLINED_BY_USER = "Declined in Tandem";

/** Shown to Codex when no human was ever asked (broker outage, no UI attached). */
export const APPROVAL_UNAVAILABLE = "Tandem approval unavailable";

/**
 * Encode a decision as the JSON-RPC `result` the app-server expects.
 *
 * `rejection` is the only text Codex sees for a refusal, so it is the one place
 * "a human said no" and "nobody could be asked" stay distinguishable on the
 * wire as well as in the logs.
 */
export function codexApprovalResult(
  method: string,
  decision: CodexApprovalDecision,
  rejection: string = DECLINED_BY_USER,
): unknown {
  if (!isLegacyCodexApprovalMethod(method)) return { decision };
  if (decision === "accept") return { decision: "approved" };
  if (decision === "acceptForSession") return { decision: "approved_for_session" };
  return { decision: { denied: { rejection } } };
}
