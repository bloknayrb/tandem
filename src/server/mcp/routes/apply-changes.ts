import type { Request, Response } from "express";
import { API_APPLY_CHANGES } from "../../../shared/api-paths.js";
import { assertOriginAllowlisted } from "../../integrations/api-routes.js";
import { applyChangesCore } from "../docx-apply.js";
import { scrubPathForCaller, sendApiError } from "./_shared.js";

export async function handleApplyChanges(req: Request, res: Response): Promise<void> {
  // CSRF (#1295's class, second instance). A `text/plain` POST is a SIMPLE
  // request, so no preflight fires and the origin allowlist never gets a say;
  // the socket is loopback, so `enforceLoopbackMutation` passes and
  // `authMiddleware` skips the token check entirely (loopback is exempted
  // before it). `express.json()` is mounted with no `type` option, so the body
  // arrives undefined -- which the destructure below tolerates. Every field
  // then defaults, and the call proceeds against the ACTIVE document.
  //
  // `assertOriginAllowlisted` is the control that bites, because it fails
  // closed on a MISSING Origin too (`LOCALHOST_ORIGIN_RE.test("")` is false),
  // and a cross-origin `no-cors` POST does carry an Origin -- that is exactly
  // why the trick works for the request and not for the response.
  //
  // `assertLoopbackForMutation` is deliberately NOT added alongside it. It
  // reads the same `req.socket.remoteAddress` that the path-wide
  // `enforceLoopbackMutation` already checks, so against this attack it does
  // nothing; what it WOULD do is make `scrubPathForCaller`'s non-loopback
  // branch formally unreachable through this route and retire the specs
  // covering it. One real gate beats a second that only looks like defence.
  if (assertOriginAllowlisted(req, res, API_APPLY_CHANGES)) return;

  const { documentId, author, backupPath } = (req.body ?? {}) as Record<string, unknown>;
  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  if (author !== undefined && typeof author !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "author must be a string" });
    return;
  }
  if (backupPath !== undefined && typeof backupPath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "backupPath must be a string" });
    return;
  }

  try {
    const result = await applyChangesCore(
      documentId as string | undefined,
      author as string | undefined,
      backupPath as string | undefined,
    );
    // #1294: when `backupPath` is omitted (the client always omits it),
    // applyChangesCore derives it from the open document's own directory, so
    // the response returns an absolute path the caller never supplied. The
    // client only renders it as "Backup saved to: …", which a basename still
    // satisfies.
    res.json({ data: { ...result, backupPath: scrubPathForCaller(req, result.backupPath) } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
