/**
 * #651 — Claude typing-presence SSE-skip invariant.
 *
 * `withMcp(...)` writes to `Y_MAP_AWARENESS` MUST NOT produce channel SSE
 * events. The typing-presence middleware uses `withMcp` for set + clear so
 * Claude never sees its own self-presence echoed back via the channel.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import type { ClaudeAwareness } from "../../src/shared/types.js";

afterEach(() => {
  resetForTesting();
});

describe("typing-presence: withMcp writes to Y_MAP_AWARENESS are channel-skipped", () => {
  let doc: Y.Doc;
  const events: TandemEvent[] = [];
  const cb = (e: TandemEvent) => events.push(e);

  beforeEach(() => {
    doc = new Y.Doc();
    attachObservers("test-doc", doc);
    events.length = 0;
    subscribe(cb);
  });

  afterEach(() => {
    unsubscribe(cb);
    detachObservers("test-doc");
    doc.destroy();
  });

  it("set-presence via withMcp produces no SSE events", () => {
    const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
    const marker: ClaudeAwareness = {
      status: "",
      timestamp: 0,
      active: false,
      focusParagraph: null,
      focusOffset: null,
      working: {
        tool: "tandem_annotationReply",
        annotationId: "ann_42",
        startedAt: Date.now(),
      },
    };
    withMcp(doc, () => {
      awarenessMap.set(Y_MAP_CLAUDE, marker);
    });

    expect(events).toHaveLength(0);
  });

  it("clear-presence via withMcp produces no SSE events", () => {
    const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
    // Seed via withMcp first (also asserted above: no event)
    withMcp(doc, () =>
      awarenessMap.set(Y_MAP_CLAUDE, {
        status: "",
        timestamp: 0,
        active: false,
        focusParagraph: null,
        focusOffset: null,
        working: {
          tool: "tandem_comment",
          startedAt: Date.now(),
        },
      } satisfies ClaudeAwareness),
    );
    events.length = 0;

    // Now clear (drop the `working` field) via withMcp
    withMcp(doc, () =>
      awarenessMap.set(Y_MAP_CLAUDE, {
        status: "",
        timestamp: 0,
        active: false,
        focusParagraph: null,
        focusOffset: null,
      } satisfies ClaudeAwareness),
    );

    expect(events).toHaveLength(0);
  });
});
