import type { NextFunction, Request, Response } from "express";

import { API_OWNERSHIP } from "../../../shared/api-paths.js";
import { crossBasename } from "../../../shared/cross-basename.js";
import { isLoopback } from "../../auth/middleware.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { ownershipEnabled } from "../../ownership-flag.js";
import {
  controlDocumentOwner,
  controlMessageOwner,
  type OwnershipControlAction,
  ownersList,
} from "../../sessions/ownership.js";
import { getOpenDocs, hasDoc } from "../document-service.js";
import { sendApiError } from "./_shared.js";

/**
 * The ownership routes (#2358 PR 5a, ADR-054; ownership design §10.1): the
 * user's Release and Assign of a document and, since PR 5a-2, of a chat
 * message, and the owners list the Assign popover reads. **Dark:** registered only while ownership is on
 * ({@link ownershipRouteGate}); flag off both paths answer exactly as an
 * unknown `/api` route does.
 *
 * Not an AI surface (Critical Rule 9): Release and Assign are the user's own
 * editing control and must work keyless. Their AI effect (step 5 of
 * `setDocOwner`: the supervisor's start-or-wake and the `ownership` frame) is
 * refused downstream, by the supervisor and by each frame writer.
 *
 * Neither route ever names an owner id: a record is its label and display
 * kind, and a held document is its file name.
 */

/**
 * The first handler of every ownership registration: while ownership is off
 * it skips the route (`next("route")`), so the request falls through to
 * whatever answers an unknown `/api` path, byte for byte (ownership design
 * §12: nothing visible while dark). Read per request, like the flag itself.
 */
export function ownershipRouteGate(_req: Request, _res: Response, next: NextFunction): void {
  if (ownershipEnabled()) next();
  else next("route");
}

const ACTIONS: ReadonlySet<string> = new Set<OwnershipControlAction>(["release", "assign"]);

/**
 * `POST /api/ownership` `{documentId, action: "release" | "assign", ownerLabel?}`
 * (ownership design §10.1). Gated at the top on the origin allowlist and on
 * loopback (so CLAUDE.md's enumeration of routes that call neither is
 * unchanged), and it requires a parsed JSON object body, so a `text/plain`
 * simple request (no preflight, `express.json` leaves the body undefined)
 * cannot reach it.
 *
 * Answers: `200 {data: {changed}}`; `400 BAD_REQUEST` for a malformed body;
 * `404 {error: "unknown-document"}` for a document that is not open;
 * `404 {error: "unknown-owner"}` for an Assign naming no live session;
 * `409 {error: "owner-detached"}` for an Assign to a session that cannot
 * take a document now; `409 {error: "busy"}` when the document's operation
 * queue did not free up within the control's wait (the change is not queued).
 *
 * The message half (#2358 PR 5a-2; ownership design §10.1, §10.2):
 * `{messageId, action, ownerLabel?}` Releases or Assigns one user chat
 * message, named by its chat id, **synchronously**: a message is not a
 * document-queue operation, so it never waits and never answers `busy`.
 * Answers: `200 {data: {changed}}`; `404 {error: "unknown-message"}`;
 * `404 unknown-owner`; `409 owner-detached`; `409 {error:
 * "follows-document"}` for a message that follows an open document (that
 * document's own Release and Assign move it); `409 {error: "answered"}` for a
 * message a final reply already answered; `409 {error: "not-controllable"}`
 * for local-period chat or a message carried over from before a restart. A
 * body naming both `documentId` and `messageId`, or neither, is a 400.
 */
export async function handleOwnershipControl(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_OWNERSHIP)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "A JSON object body is required" });
    return;
  }
  const { documentId, action, ownerLabel, messageId } = body as Record<string, unknown>;
  if (documentId !== undefined && messageId !== undefined) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message: "Name either documentId or messageId, not both",
    });
    return;
  }
  const isMessage = messageId !== undefined;
  if (isMessage && (typeof messageId !== "string" || messageId === "")) {
    res.status(400).json({ error: "BAD_REQUEST", message: "messageId must be a non-empty string" });
    return;
  }
  if (!isMessage && (typeof documentId !== "string" || documentId === "")) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId or messageId is required" });
    return;
  }
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    res.status(400).json({ error: "BAD_REQUEST", message: 'action must be "release" or "assign"' });
    return;
  }
  if (action === "assign" && (typeof ownerLabel !== "string" || ownerLabel === "")) {
    res.status(400).json({ error: "BAD_REQUEST", message: "ownerLabel is required to assign" });
    return;
  }
  if (action === "release" && ownerLabel !== undefined) {
    res.status(400).json({ error: "BAD_REQUEST", message: "release takes no ownerLabel" });
    return;
  }
  if (isMessage) {
    controlMessage(res, messageId as string, action as OwnershipControlAction, ownerLabel);
    return;
  }
  if (typeof documentId !== "string") {
    // Unreachable (checked above); kept so a later edit cannot leave the request unanswered.
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId or messageId is required" });
    return;
  }
  if (!hasDoc(documentId)) {
    res.status(404).json({ error: "unknown-document" });
    return;
  }
  const abort = new AbortController();
  // Only a client that went away before the answer was written: `close` also
  // fires after a normal response, when there is nothing left to cancel.
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const outcome = await controlDocumentOwner(
      documentId,
      action as OwnershipControlAction,
      action === "assign" ? (ownerLabel as string) : undefined,
      () => hasDoc(documentId),
      abort.signal,
    );
    switch (outcome) {
      case "changed":
      case "unchanged":
        res.json({ data: { changed: outcome === "changed" } });
        return;
      case "unknown-owner":
        res.status(404).json({ error: "unknown-owner" });
        return;
      case "not-open":
        res.status(404).json({ error: "unknown-document" });
        return;
      case "owner-detached":
        res.status(409).json({ error: "owner-detached" });
        return;
      case "busy":
        res.status(409).json({ error: "busy" });
        return;
      case "cancelled":
        // The caller is gone; there is nobody to answer.
        return;
    }
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}

/** The message half of `POST /api/ownership` (#2358 PR 5a-2): one synchronous decision and write. */
function controlMessage(
  res: Response,
  messageId: string,
  action: OwnershipControlAction,
  ownerLabel: unknown,
): void {
  try {
    const outcome = controlMessageOwner(
      messageId,
      action,
      action === "assign" ? (ownerLabel as string) : undefined,
    );
    switch (outcome) {
      case "changed":
      case "unchanged":
        res.json({ data: { changed: outcome === "changed" } });
        return;
      case "unknown-message":
      case "unknown-owner":
        res.status(404).json({ error: outcome });
        return;
      case "owner-detached":
      case "follows-document":
      case "answered":
      case "not-controllable":
        res.status(409).json({ error: outcome });
        return;
    }
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}

/**
 * `GET /api/ownership/owners` (ownership design §10.1): `{data: [{label,
 * displayKind, holds, canTake}]}` for every attached session and for
 * Tandem's Claude while present; `holds` is the file names of the open
 * documents it holds. GET is outside the path-wide loopback invariant, so the
 * handler checks the socket's peer address itself (never the `Host` header)
 * and answers 403 otherwise.
 */
export function handleOwnersList(req: Request, res: Response): void {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({
      error: "FORBIDDEN",
      message: "This route is loopback-only: it must be called from the computer running Tandem.",
    });
    return;
  }
  try {
    const docs = getOpenDocs();
    const data = ownersList().map((owner) => ({
      label: owner.label,
      displayKind: owner.displayKind,
      holds: owner.holds.flatMap((id) => {
        const doc = docs.get(id);
        return doc === undefined ? [] : [crossBasename(doc.filePath)];
      }),
      canTake: owner.canTake,
    }));
    res.json({ data });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
