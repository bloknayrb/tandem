/**
 * SSE endpoint handler for streaming TandemEvents to the channel shim.
 *
 * Mount as `GET /api/events` on the Express app.
 */

import type { Request, Response } from "express";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../shared/constants.js";
import { replaySince, subscribe, unsubscribe } from "./queue.js";
import type { TandemEvent } from "./types.js";

/** Express route handler for SSE event stream. */
export function sseHandler(req: Request, res: Response): void {
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Replay buffered events on reconnection
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId) {
    const missed = replaySince(lastEventId);
    for (const event of missed) {
      writeEvent(res, event);
    }
  }

  // Immediate flush so the client knows the connection is alive
  res.write(": connected\n\n");

  // keepalive must be declared before onEvent so the error handler can clear it
  // eslint-disable-next-line prefer-const
  let keepalive: ReturnType<typeof setInterval>;
  const onEvent = (event: TandemEvent) => {
    try {
      writeEvent(res, event);
    } catch (err) {
      console.error(
        "[SSE] Write failed, cleaning up subscriber:",
        err instanceof Error ? err.message : err,
      );
      clearInterval(keepalive);
      unsubscribe(onEvent);
    }
  };
  subscribe(onEvent);

  // Keepalive to detect broken connections
  keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, CHANNEL_SSE_KEEPALIVE_MS);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe(onEvent);
    console.error("[SSE] Client disconnected from /api/events");
  });

  console.error("[SSE] Client connected to /api/events");
}

function writeEvent(res: Response, event: TandemEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
