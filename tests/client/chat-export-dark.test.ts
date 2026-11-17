/**
 * Chat export while local models are dark (#1123 part B, R10.1), moved out of
 * `chat-export.test.ts` so that file holds in either state of the flag. The
 * guard pinned: `chat-export.ts`'s `BYO_MODELS_ENABLED` test that labels a
 * notice row as Tandem's only when lit.
 */
import { describe, expect, it, vi } from "vitest";
import { exportChatMarkdown } from "../../src/client/panels/chat-export";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

describe("flag off (#1123 part B, R10.1)", () => {
  it("a notice row restored from a flag-on build is exported as Claude's, as on master", () => {
    const md = exportChatMarkdown(
      [
        {
          id: "n",
          author: "claude",
          text: "notice",
          timestamp: 0,
          read: true,
          chatNotice: "no-reply",
        },
      ],
      [],
    );
    expect(md).toContain("**Claude**");
    expect(md).not.toContain("**Tandem**");
  });
});
