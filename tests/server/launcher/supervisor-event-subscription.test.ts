/**
 * Does the launcher supervisor's event subscription sit behind the Solo gate?
 *
 * WHY ITS OWN FILE. These two tests belong conceptually with the Solo forwarder
 * gate in `event-queue.test.ts`, and they lived there first. They cannot stay:
 * that file replaces `yjs/provider.js` wholesale with a two-export `vi.mock`,
 * and importing the supervisor drags `codex/approval-broker.js` →
 * `mcp/annotations.js` → `mcp/document.js` → `documents/registry.js` into the
 * graph, which calls `setShouldKeepDocument` on that mock at module scope. The
 * result is a whole test FILE failing to load — reported as `1 failed` with
 * zero failing tests, which reads like anything but the real cause.
 *
 * `event-queue.test.ts`'s own note anticipated this ("If that changes, move
 * CTRL_ROOM tests to a separate file"). This is that file: real provider, real
 * queue, no mocks.
 *
 * WHAT IT PINS. `defaultSubscribeToEvents` passes `"external"` to `subscribe`.
 * That single word is what keeps Solo mode from leaking into a spawned Claude:
 * the launched process is a consumer OUTSIDE this process, so it must be held
 * by `shouldForwardExternally` exactly as the SSE consumers are. `"internal"`
 * would sail straight past the gate. Nothing else in the suite would notice.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _pushEventForTests, resetForTesting } from "../../../src/server/events/queue.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import { defaultSubscribeToEvents } from "../../../src/server/launcher/supervisor.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";

beforeEach(() => {
  resetForTesting();
});

afterEach(() => {
  setCtrlMode(null);
  resetForTesting();
});

/** A `document:*` event: NOT privacy-held pre-buffer (so it reaches the
 * fan-out), but withheld from external consumers unless mode reads Tandem —
 * which makes it the event that isolates the forwarder gate. */
function docEvent(id: string): TandemEvent {
  return {
    id,
    type: "document:opened",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { fileName: "secret-plan.md", format: "md" },
  } as TandemEvent;
}

describe("launcher supervisor's default event subscription", () => {
  it("is withheld in Solo", () => {
    setCtrlMode("solo");
    const seen: TandemEvent[] = [];
    const off = defaultSubscribeToEvents((e) => seen.push(e));
    _pushEventForTests(docEvent("ev-sup-solo"));
    off();

    expect(seen).toHaveLength(0);
  });

  // Positive control for the test above, same subscription and same event with
  // only the mode flipped. Without it, "withheld in Solo" would also pass if
  // the subscription were broken outright and delivered nothing ever.
  it("is delivered in Tandem", () => {
    setCtrlMode("tandem");
    const seen: TandemEvent[] = [];
    const off = defaultSubscribeToEvents((e) => seen.push(e));
    _pushEventForTests(docEvent("ev-sup-tandem"));
    off();

    expect(seen).toHaveLength(1);
  });

  // The gate tests `=== "tandem"`, not `!== "solo"`. An absent mode key is
  // "indeterminate" — we may have been in Solo and no longer know — and must
  // fail CLOSED, or a lost/corrupt session on restart would resume pushing at
  // a model mid-Solo.
  it("is withheld when mode is indeterminate", () => {
    setCtrlMode(null);
    const seen: TandemEvent[] = [];
    const off = defaultSubscribeToEvents((e) => seen.push(e));
    _pushEventForTests(docEvent("ev-sup-indeterminate"));
    off();

    expect(seen).toHaveLength(0);
  });
});
