/**
 * Chat notifications while local models are dark (#1123 part B, R10.1), moved
 * out of `chat-attention.test.ts` so that file holds in either state of the
 * flag. The guard pinned: `chat-attention.ts`'s `BYO_MODELS_ENABLED` tests that
 * name a local reply's author and leave notice rows uncounted only when lit.
 */
import { describe, expect, it, vi } from "vitest";
import { buildNotificationText } from "../../src/client/notifications/chat-attention";
import type { ChatMessage } from "../../src/shared/types";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

describe("buildNotificationText, flag off (#1123 part B, R10.1)", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, author: "claude", text: id, timestamp: 0, read: true, ...extra }) as ChatMessage;
  it("a local reply is titled as Claude's, and a notice row is counted, as on master", () => {
    const local = row("a", { agentIdentity: { provider: "local-ollama", displayName: "Qwen" } });
    expect(buildNotificationText([local], "generic", () => null).title).toBe("Claude replied");
    expect(
      buildNotificationText([row("b"), row("n", { chatNotice: "no-reply" })], "generic", () => null)
        .title,
    ).toBe("Claude sent 2 replies");
  });
});
