/**
 * SSE endpoint handler for streaming TandemEvents to the channel shim.
 *
 * Mount as `GET /api/events` on the Express app.
 */

import type { Request, Response } from "express";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../shared/constants.js";
import { isWakeWorthy, toWakeFrame } from "../../shared/events/wake-scope.js";
import { replaySince, subscribe, unsubscribe } from "./queue.js";
import type { TandemEvent } from "./types.js";

/**
 * Is this connection asking for the wake stream, the full one, or nonsense?
 *
 * Strict `=== "wake"`, and the strictness is not fussiness: `req.query.filter`
 * is `string | string[] | ParsedQs | ParsedQs[]` on Express, so `?filter=wake&
 * filter=x` arrives as an ARRAY and `?filter[a]=b` as an OBJECT. A loose check
 * (`includes`, truthiness, `startsWith`) would accept one of those and then be
 * read as "wake mode" by one branch and "full mode" by another.
 *
 * Three-valued rather than `"wake" | null`, because ABSENT and UNRECOGNISED are
 * not the same request and must not get the same answer. Absent is every
 * existing consumer (channel shim, plugin monitor) and correctly means the full
 * stream. Unrecognised — `?filter=Wake`, `?filter=wake%20`, an array — is a
 * caller that asked to be narrowed and, on the old `null` fallback, was silently
 * handed the OPPOSITE: whole message bodies pushed at a model, which per ADR-049
 * decision 2 is exactly what causes duplicate replies and answering from a view
 * the model cannot know is incomplete. Failing open on a typo in a privacy
 * narrowing is the wrong direction; that case now 400s.
 */
export type WakeFilterVerdict = "wake" | "none" | "invalid";

export function parseWakeFilter(raw: unknown): WakeFilterVerdict {
  if (raw === undefined) return "none";
  return raw === "wake" ? "wake" : "invalid";
}

/** Express route handler for SSE event stream. */
export function sseHandler(req: Request, res: Response): void {
  // Opt-in, per connection. Existing consumers send no `filter` and are
  // completely unaffected — the channel shim and plugin monitor still receive
  // whole events, so this cannot regress them.
  const verdict = parseWakeFilter(req.query?.filter);
  if (verdict === "invalid") {
    // Refused before the stream opens, so the caller sees a status code rather
    // than an event stream quietly carrying more than it asked for.
    res.status(400).json({
      error: "INVALID_FILTER",
      message: 'Unsupported `filter`. The only supported value is "wake"; omit it for full events.',
    });
    return;
  }
  const wakeMode = verdict === "wake";
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Replay buffered events on reconnection
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId) {
    // COMPOSED on `replaySince`'s return value, never branched inside it. That
    // function carries a MANDATORY Solo filter guarding its own riskiest path —
    // an unknown `lastEventId` (client-controlled, from a header) falls back to
    // the ENTIRE buffer. Narrowing here is strictly downstream of that, so this
    // can only ever remove events, never add one back.
    const missed = replaySince(lastEventId);
    for (const event of missed) {
      if (wakeMode && !isWakeWorthy(event)) continue;
      writeEvent(res, event, wakeMode);
    }
  }

  // Immediate flush so the client knows the connection is alive
  res.write(": connected\n\n");

  // keepalive must be declared before cleanup/onEvent so they can clear it
  // eslint-disable-next-line prefer-const
  let keepalive: ReturnType<typeof setInterval>;
  function cleanup(): void {
    clearInterval(keepalive);
    unsubscribe(onEvent);
  }
  const onEvent = (event: TandemEvent) => {
    if (wakeMode && !isWakeWorthy(event)) return;
    try {
      writeEvent(res, event, wakeMode);
    } catch (err) {
      console.error(
        "[SSE] Write failed, cleaning up subscriber:",
        err instanceof Error ? err.message : err,
      );
      cleanup();
    }
  };
  // The SSE stream is the one true external consumer — a channel shim or plugin
  // monitor on the other end. See `externalSubscribers` in queue.ts.
  subscribe(onEvent, "external");

  // Keepalive to detect broken connections. The write MUST be guarded: on an
  // abruptly-closed socket (client SIGKILL / network drop, before req "close"
  // fires) it throws EPIPE/ECONNRESET, and an unwrapped throw inside a
  // setInterval callback is an uncaught exception — EPIPE/ECONNRESET are not
  // known-Hocuspocus errors, so handleFatalError would process.exit(1) the
  // whole server. Mirror the browser notify-stream keepalive guard.
  keepalive = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    } catch (err) {
      console.error(
        "[SSE] Keepalive write failed, cleaning up subscriber:",
        err instanceof Error ? err.message : err,
      );
      cleanup();
    }
  }, CHANNEL_SSE_KEEPALIVE_MS);

  // Cleanup on disconnect
  req.on("close", () => {
    cleanup();
    console.error("[SSE] Client disconnected from /api/events");
  });

  console.error("[SSE] Client connected to /api/events");
}

/**
 * The `id:` line is written identically in both modes — `Last-Event-ID`
 * resumption has to keep working for a wake consumer, and the id is opaque.
 * Only the `data:` body differs: ADR-049 makes the wake frame payload-free, so
 * `toWakeFrame` is what a wake consumer receives, whole events are what
 * everyone else receives.
 */
function writeEvent(res: Response, event: TandemEvent, wakeMode: boolean): void {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(wakeMode ? toWakeFrame(event) : event)}\n\n`);
}
