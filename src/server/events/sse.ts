/**
 * SSE endpoint handler for streaming TandemEvents to the channel shim.
 *
 * Mount as `GET /api/events` on the Express app.
 */

import type { Request, Response } from "express";
import { subscribe, unsubscribe, replaySince } from "./queue.js";
import type { TandemEvent } from "./types.js";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../shared/constants.js";

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

  // Subscribe to new events
  const onEvent = (event: TandemEvent) => {
    writeEvent(res, event);
  };
  subscribe(onEvent);

  // Keepalive to detect broken connections
  const keepalive = setInterval(() => {
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
