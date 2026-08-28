import type { Request, Response } from "express";
import { API_CONVERT } from "../../../shared/api-paths.js";
import { assertOriginAllowlisted } from "../../integrations/api-routes.js";
import { convertToMarkdown } from "../convert.js";
import { scrubPathForCaller, sendApiError } from "./_shared.js";

export async function handleConvert(req: Request, res: Response): Promise<void> {
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
  if (assertOriginAllowlisted(req, res, API_CONVERT)) return;

  const { documentId, outputPath } = (req.body ?? {}) as Record<string, unknown>;
  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  if (outputPath !== undefined && typeof outputPath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "outputPath must be a string" });
    return;
  }

  try {
    const result = await convertToMarkdown(
      documentId as string | undefined,
      outputPath as string | undefined,
    );
    // #1294: when the caller omits `outputPath`, `convertToMarkdown` derives it
    // from the open document's directory — so the response returns an absolute
    // path the caller never supplied. `findAvailablePath` can also rename it
    // (`x-1.md`), so even a caller-supplied path comes back changed; basenaming
    // keeps the part that changed and drops the part that discloses layout.
    res.json({ data: { ...result, outputPath: scrubPathForCaller(req, result.outputPath) } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
