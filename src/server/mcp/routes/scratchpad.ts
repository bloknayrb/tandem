import type { Request, Response } from "express";
import { API_SCRATCHPAD } from "../../../shared/api-paths.js";
import { openScratchpad, toWireResult } from "../../documents/open.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { sendApiError } from "./_shared.js";

const MAX_SCRATCHPAD_CONTENT_BYTES = 1024 * 1024;

export async function handleScratchpad(req: Request, res: Response): Promise<void> {
  // #1295 L1. This comment used to say scratchpad was the ONLY mutating route
  // with neither gate, and that every sibling called assertOriginAllowlisted.
  // Both halves were false when written: a later sweep found NINE routes calling
  // neither, and three of them (`save`, `convert`, `apply-changes`) were
  // reachable by the very attack written out below — `/api/save`
  // unconditionally, overwriting the user's open document. Those three are gated
  // now; `open`, `upload`, `close`, `annotation-reply`, `remove-annotation` and
  // `rotate-token` still call neither, for the reasons in CLAUDE.md.
  //
  // Keeping the corrected version rather than deleting it: a fix comment that
  // overstates how isolated its bug was is how the same bug gets rediscovered
  // three surfaces later.
  //
  // The attack, unchanged and still the clearest statement of the class —
  // reachable by any page the user visits:
  //
  //   fetch('http://127.0.0.1:3479/api/scratchpad', {method:'POST',
  //         mode:'no-cors', headers:{'Content-Type':'text/plain'}})
  //
  // A `text/plain` POST is a SIMPLE request, so no preflight fires; the socket
  // is loopback so auth is bypassed; express.json ignores the content type, so
  // `req.body` is undefined — which the handler below explicitly permits. The
  // attacker cannot read the response or inject content (the `content` field
  // needs application/json, which does preflight), but openScratchpad calls
  // setActiveDocId, silently flipping the server's active document. That doc
  // then becomes the implicit target of any later documentId-less MCP call.
  if (assertOriginAllowlisted(req, res, API_SCRATCHPAD)) return;
  if (assertLoopbackForMutation(req, res)) return;

  const body = req.body;
  if (
    body !== undefined &&
    (body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "content"))
  ) {
    res.status(400).json({ error: "BAD_REQUEST", message: "Expected { content?: string }." });
    return;
  }
  const content = (body as { content?: unknown } | undefined)?.content;
  if (content !== undefined && typeof content !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "content must be a string." });
    return;
  }
  if (
    typeof content === "string" &&
    Buffer.byteLength(content, "utf8") > MAX_SCRATCHPAD_CONTENT_BYTES
  ) {
    res.status(413).json({
      error: "PAYLOAD_TOO_LARGE",
      message: "Scratchpad content must be no larger than 1 MiB.",
    });
    return;
  }
  try {
    const result = await openScratchpad(content as string | undefined);
    res.json({ data: toWireResult(result) });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
