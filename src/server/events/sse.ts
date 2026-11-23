/**
 * SSE endpoint handler for streaming TandemEvents to the channel shim.
 *
 * Mount as `GET /api/events` on the Express app.
 *
 * With multi-session ownership on (#2358 PR 4a, ships dark), each stream is
 * narrowed by its `X-Claude-Session-Id` (`pushStreamAdmits`, ownership design
 * §9.1), and every stream also gets the payload-free `ownership-changed`
 * nudge ({@link requestOwnershipChangedEvent}), which is not an event.
 */

import type { Request, Response } from "express";
import { CLAUDE_SESSION_HEADER, normalizeSessionId } from "../../shared/cli-runtime.js";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../shared/constants.js";
import {
  isWakeWorthy,
  OWNERSHIP_CHANGED_SSE_FRAME,
  toWakeFrame,
} from "../../shared/events/wake-scope.js";
import { aiRefusal, sendAiRefusal } from "../license/ai-refusal.js";
import { pushStreamAdmits } from "../sessions/ownership.js";
import { chatMessageRowKeyOf } from "./delivery-state.js";
import { replaySince, subscribe, unsubscribe } from "./queue.js";
import type { TandemEvent } from "./types.js";

/** One open `/api/events` stream, for the `ownership-changed` writer. */
interface LiveStream {
  readonly res: Response;
  /** Stop its keepalive and unsubscribe it (and forget it here). */
  cleanup(): void;
  /** End it as unlicensed, exactly as the subscription's `onRevoke` does. */
  revoke(): void;
}

/** The open streams. Every one gets the `ownership-changed` nudge, mapped or not. */
const liveStreams = new Set<LiveStream>();

/**
 * How long the `ownership-changed` writer gathers requests before it writes
 * one frame (#2358 PR 4a): the same window, for the same reason, as the
 * `/api/wake` `ownership` frame's (`OWNERSHIP_FRAME_COALESCE_MS` in
 * `wake-socket.ts`). One change of hands can ask many times within a few
 * milliseconds; the frame carries nothing, so one is enough.
 */
const OWNERSHIP_CHANGED_COALESCE_MS = 100;

let ownershipChangedDelayMs = OWNERSHIP_CHANGED_COALESCE_MS;
let ownershipChangedTimer: ReturnType<typeof setTimeout> | undefined;

/** Tests only: the coalescing window (`undefined` restores the default). */
export function setOwnershipChangedDelayForTests(ms: number | undefined): void {
  ownershipChangedDelayMs = ms ?? OWNERSHIP_CHANGED_COALESCE_MS;
}

/**
 * Ask for one payload-free `ownership-changed` frame on every open
 * `/api/events` stream (#2358 PR 4a; ADR-054; ownership design §8.6, §9.1),
 * mapped or not, so a session reached only by a push stream (the channel
 * shim, the plugin monitor) is nudged to poll when work changes hands. Reached
 * only through ownership's frame sink, which `src/server/index.ts` sets beside
 * the `/api/wake` frame's and which only a flag-on change of owner calls, so
 * a dark server never arms the timer. Requests within
 * {@link OWNERSHIP_CHANGED_COALESCE_MS} of the first become one frame. Never
 * throws.
 */
export function requestOwnershipChangedEvent(): void {
  if (ownershipChangedTimer !== undefined || liveStreams.size === 0) return;
  ownershipChangedTimer = setTimeout(() => {
    ownershipChangedTimer = undefined;
    writeOwnershipChangedEvent();
  }, ownershipChangedDelayMs);
  ownershipChangedTimer.unref?.();
}

/**
 * The `ownership-changed` writer: an AI surface outside `pushEvent`
 * (Critical Rule 9; ownership design §8.6), so it never inherits that
 * function's revocation and asks the licence itself, at the moment it writes.
 * A refusal ends every open stream exactly as the subscription's `onRevoke`
 * does, and writes nothing; so does a decision that throws (the streams are
 * then left open: nothing was decided). The frame is
 * `OWNERSHIP_CHANGED_SSE_FRAME`: no `id:` line, so it never moves a
 * consumer's `Last-Event-ID`, and an empty `data: {}`.
 */
function writeOwnershipChangedEvent(): void {
  const streams = [...liveStreams];
  if (streams.length === 0) return;
  let refused: boolean;
  try {
    refused = aiRefusal() !== null;
  } catch {
    console.error("[SSE] The licence could not be read; no ownership-changed event was written.");
    return;
  }
  if (refused) {
    for (const stream of streams) stream.revoke();
    return;
  }
  for (const stream of streams) {
    try {
      if (!stream.res.writableEnded) stream.res.write(OWNERSHIP_CHANGED_SSE_FRAME);
    } catch (err) {
      console.error(
        "[SSE] Write failed, cleaning up subscriber:",
        err instanceof Error ? err.message : err,
      );
      stream.cleanup();
    }
  }
}

/**
 * Whether the stream whose `X-Claude-Session-Id` is `sessionId` gets `event`
 * (ownership design §9.1). Always true while ownership is off.
 */
function streamAdmits(sessionId: string | undefined, event: TandemEvent): boolean {
  return pushStreamAdmits(
    sessionId,
    event.type === "chat:message"
      ? {
          documentId: event.documentId,
          // The row's chat-map key, as the CTRL chat observer noted it: the
          // payload's `messageId` is the row's client-writable `id` field, not
          // its key (R1.1), so a row whose `id` names another row's key would
          // otherwise be narrowed as that row. The `messageId` only for an
          // event pushed with no noted key (rounds not keyed).
          chatMessageKey: chatMessageRowKeyOf(event) ?? event.payload.messageId,
        }
      : { documentId: event.documentId },
  );
}

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
  // Licence admission (#1521): before `writeHead`, so a refused consumer gets
  // a status code it can read and `replaySince` never runs for it. The shared
  // SSE consumer keys on this body's `error` and backs off instead of counting
  // it as an outage.
  const refusal = aiRefusal();
  if (refusal) {
    sendAiRefusal(res, refusal);
    return;
  }
  const wakeMode = verdict === "wake";
  // The stream's identity for ownership's narrowing (#2358 PR 4a): read once,
  // mapped afresh for each event. Unused while ownership is off.
  const sessionId = normalizeSessionId(req.headers[CLAUDE_SESSION_HEADER.toLowerCase()]);
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
      if (!streamAdmits(sessionId, event)) continue;
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
    liveStreams.delete(stream);
  }
  const onEvent = (event: TandemEvent) => {
    if (wakeMode && !isWakeWorthy(event)) return;
    if (!streamAdmits(sessionId, event)) return;
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
  //
  // `onRevoke` (#1521): an event pushed while Tandem is unlicensed ends this
  // stream. The consumer's reconnect then meets the 403 above.
  //
  // The same `revoke` ends the stream when the `ownership-changed` writer
  // meets a refusal (#2358 PR 4a), which is outside `pushEvent`.
  const revoke = (): void => {
    cleanup();
    try {
      if (!res.writableEnded) res.end();
    } catch (err) {
      console.error(
        "[SSE] Ending a revoked stream failed:",
        err instanceof Error ? err.message : err,
      );
    }
    console.error("[SSE] Stream ended: AI features are unlicensed");
  };
  const stream: LiveStream = { res, cleanup, revoke };
  subscribe(onEvent, "external", { onRevoke: revoke });
  liveStreams.add(stream);

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
