/**
 * The reply detector while local models are dark (#1123 part B, R10.1), moved
 * out of `reply-detector.test.ts` so that file holds in either state of the
 * flag. The guard pinned: `reply-detector.ts`'s `BYO_MODELS_ENABLED` test that
 * splits notice rows from replies only when lit.
 */
import { describe, expect, it, vi } from "vitest";
import { createReplyDetector } from "../../src/client/notifications/reply-detector";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

describe("flag off (#1123 part B, R10.1)", () => {
  it("a notice row is announced as a reply, as on master; the notices detector returns nothing", () => {
    const doc = {};
    const notice = {
      id: "n",
      author: "claude" as const,
      text: "x",
      timestamp: Date.now(),
      read: true,
      chatNotice: "no-reply" as const,
    };
    const replies = createReplyDetector();
    const notices = createReplyDetector({ select: "notices" });
    for (const d of [replies, notices]) {
      d.observe({ doc, synced: true, baselineIds: [], messages: [], streamingIds: new Set() });
    }
    const input = {
      doc,
      synced: true,
      baselineIds: [],
      messages: [notice],
      streamingIds: new Set<string>(),
    };
    expect(replies.observe(input).map((m) => m.id)).toEqual(["n"]);
    expect(notices.observe(input)).toEqual([]);
  });
});
