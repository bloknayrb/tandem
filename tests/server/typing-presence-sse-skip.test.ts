/**
 * #651 — Claude typing-presence SSE-skip invariant.
 *
 * `withMcp(...)` writes to `Y_MAP_AWARENESS` (under the `Y_MAP_CLAUDE` sub-key)
 * MUST NOT produce channel SSE events. The typing-presence middleware uses
 * `withMcp` for set + clear so Claude never sees its own self-presence echoed
 * back via the channel.
 *
 * NOTE (#823): an earlier version of this test attached the event-queue
 * observers and asserted `events.toHaveLength(0)`. That was vacuous — the
 * production observers watch `Y_MAP_USER_AWARENESS` (selections), NOT
 * `Y_MAP_AWARENESS` (Claude's `working` marker), so NO observer fired for ANY
 * origin and the assertion passed even for `withBrowser` (which is NOT in the
 * channel-skip set). This rewrite verifies the actual invariant two ways:
 *
 *   1. Directly against `shouldSkipChannel` — the predicate the real observers
 *      gate on — for both the skipped (`mcp`) and non-skipped (`browser`)
 *      origins. This is the contract the awareness-write path relies on.
 *
 *   2. Via a faithful stand-in observer on `Y_MAP_AWARENESS` that reproduces
 *      the production gate (`if (shouldSkipChannel(txn.origin)) return;`) and
 *      pushes to a real event sink otherwise. The `withBrowser` positive
 *      control MUST emit, and the `withMcp` write MUST NOT — so a regression
 *      that made the gate skip everything (or nothing) is caught.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../src/shared/constants.js";
import {
  BROWSER_ORIGIN,
  MCP_ORIGIN,
  shouldSkipChannel,
  withBrowser,
  withMcp,
} from "../../src/shared/origins.js";
import type { ClaudeAwareness } from "../../src/shared/types.js";

function makeMarker(tool: string): ClaudeAwareness {
  return {
    status: "",
    timestamp: 0,
    active: false,
    focusParagraph: null,
    focusOffset: null,
    working: { tool, startedAt: Date.now(), token: 1 },
  };
}

describe("typing-presence: awareness writes honor the channel-skip set", () => {
  it("the skip predicate skips mcp-origin awareness writes but not browser writes", () => {
    // (Approach b) Assert directly against the contract the real awareness
    // observers gate on. If a future change dropped `mcp` from CHANNEL_SKIP,
    // this fails — the presence middleware would start leaking SSE events.
    expect(shouldSkipChannel(MCP_ORIGIN)).toBe(true);
    // Positive control: browser writes must still emit (NOT skipped).
    expect(shouldSkipChannel(BROWSER_ORIGIN)).toBe(false);
  });

  describe("via a faithful Y_MAP_AWARENESS observer that reproduces the production gate", () => {
    let doc: Y.Doc;
    const emitted: Array<{ origin: unknown }> = [];
    let observer: ((event: Y.YMapEvent<unknown>, txn: Y.Transaction) => void) | null = null;

    beforeEach(() => {
      doc = new Y.Doc();
      emitted.length = 0;
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      observer = (_event, txn) => {
        // Mirrors the real observers: skip internal-origin writes, emit the rest.
        if (shouldSkipChannel(txn.origin)) return;
        emitted.push({ origin: txn.origin });
      };
      awarenessMap.observe(observer);
    });

    afterEach(() => {
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      if (observer) awarenessMap.unobserve(observer);
      observer = null;
      doc.destroy();
    });

    it("set-presence via withMcp does NOT emit, but a browser write DOES", () => {
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);

      // mcp-origin set: the gate must skip it — no emit.
      withMcp(doc, () => awarenessMap.set(Y_MAP_CLAUDE, makeMarker("tandem_comment")));
      expect(emitted).toHaveLength(0);

      // Positive control: a browser write to the SAME map MUST emit. This is
      // what makes the assertion above non-vacuous — the observer demonstrably
      // fires when the origin is not skipped.
      withBrowser(doc, () => awarenessMap.set(Y_MAP_CLAUDE, makeMarker("user-edit")));
      expect(emitted).toHaveLength(1);
      expect(emitted[0].origin).toBe(BROWSER_ORIGIN);
    });

    it("clear-presence via withMcp does NOT emit", () => {
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      // Seed (mcp — skipped) then clear (mcp — skipped).
      withMcp(doc, () => awarenessMap.set(Y_MAP_CLAUDE, makeMarker("tandem_edit")));
      withMcp(doc, () =>
        awarenessMap.set(Y_MAP_CLAUDE, {
          status: "",
          timestamp: 0,
          active: false,
          focusParagraph: null,
          focusOffset: null,
        } satisfies ClaudeAwareness),
      );
      expect(emitted).toHaveLength(0);
    });
  });
});
