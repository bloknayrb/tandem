/**
 * The chat's consumers of notice rows and local replies (#1123 part B, R5.2,
 * R6.2, R6.3, R9.2), with `BYO_MODELS_ENABLED` flipped on by mocking the
 * constant. The last describe re-imports nothing: each assertion of flag-off
 * behaviour lives beside its consumer's own test file, which runs with the
 * shipped constant.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/shared/types";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const { createReplyDetector } = await import("../../src/client/notifications/reply-detector");
const { buildNotificationText } = await import("../../src/client/notifications/chat-attention");
const { exportChatMarkdown } = await import("../../src/client/panels/chat-export");
const { showClaudeCodeOffer } = await import("../../src/client/panels/chat-claude-code-offer");

const T0 = 1_800_000_000_000;
const claude = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: "claude",
  text: `text ${id}`,
  timestamp: T0,
  read: true,
  ...extra,
});
const LOCAL = { provider: "local-ollama" as const, displayName: "Qwen" };
const KINDS = ["no-document", "no-local-model", "no-reply", "claude-again"] as const;

describe("the reply detector never announces a notice row (R6.2)", () => {
  const doc = {};
  function live(select?: "replies" | "notices") {
    const d = createReplyDetector({ now: () => T0, ...(select ? { select } : {}) });
    d.observe({ doc, synced: true, baselineIds: [], messages: [], streamingIds: new Set() });
    return d;
  }
  for (const kind of KINDS) {
    it(`${kind}: alone, the replies detector returns nothing; the notices detector returns it`, () => {
      const n = claude("n", { chatNotice: kind });
      const input = {
        doc,
        synced: true,
        baselineIds: [],
        messages: [n],
        streamingIds: new Set<string>(),
      };
      expect(live().observe(input)).toEqual([]);
      expect(
        live("notices")
          .observe(input)
          .map((m) => m.id),
      ).toEqual(["n"]);
    });
  }

  it("in a batch with a reply: the reply only; the notice only to the notices detector", () => {
    const msgs = [claude("r"), claude("n", { chatNotice: "no-reply", replyTo: "u" })];
    const input = {
      doc,
      synced: true,
      baselineIds: [],
      messages: msgs,
      streamingIds: new Set<string>(),
    };
    expect(
      live()
        .observe(input)
        .map((m) => m.id),
    ).toEqual(["r"]);
    expect(
      live("notices")
        .observe(input)
        .map((m) => m.id),
    ).toEqual(["n"]);
  });

  it("history (the baseline) is not announced by the notices detector either", () => {
    const n = claude("n", { chatNotice: "no-reply" });
    const d = createReplyDetector({ now: () => T0, select: "notices" });
    expect(
      d.observe({ doc, synced: true, baselineIds: ["n"], messages: [n], streamingIds: new Set() }),
    ).toEqual([]);
  });
});

describe("the notification title (R9.2, Ruling B-b)", () => {
  const name = () => "notes.md";
  const title = (replies: ChatMessage[]) => buildNotificationText(replies, "generic", name).title;
  it("a local reply: 'Your local model replied', never its name", () => {
    expect(title([claude("a", { agentIdentity: LOCAL })])).toBe("Your local model replied");
    expect(
      buildNotificationText(
        [claude("a", { agentIdentity: LOCAL, documentId: "d" })],
        "document",
        name,
      ).title,
    ).toBe("Your local model replied in notes.md");
  });
  it("several local replies: 'Your local model sent N replies'", () => {
    expect(
      title([claude("a", { agentIdentity: LOCAL }), claude("b", { agentIdentity: LOCAL })]),
    ).toBe("Your local model sent 2 replies");
  });
  it("a mixed batch: 'N new replies'", () => {
    expect(title([claude("a", { agentIdentity: LOCAL }), claude("b")])).toBe("2 new replies");
  });
  it("Claude only: unchanged", () => {
    expect(title([claude("a")])).toBe("Claude replied");
    expect(title([claude("a"), claude("b")])).toBe("Claude sent 2 replies");
  });
  it("a notice row is never counted", () => {
    expect(title([claude("a"), claude("n", { chatNotice: "no-reply" })])).toBe("Claude replied");
  });
});

describe("export (R6.3, Ruling B-c)", () => {
  for (const kind of KINDS) {
    it(`${kind}: exported under 'Tandem', not as Claude's words`, () => {
      const md = exportChatMarkdown([claude("n", { chatNotice: kind, text: "the notice" })], []);
      expect(md).toContain("**Tandem**");
      expect(md).not.toContain("**Claude**");
    });
  }
  it("a local reply keeps its displayName; Claude's reply keeps Claude", () => {
    const md = exportChatMarkdown(
      [claude("a", { agentIdentity: LOCAL }), claude("b", { timestamp: T0 + 1 })],
      [],
    );
    expect(md).toContain("**Qwen**");
    expect(md).toContain("**Claude**");
  });
});

describe("the Claude Code offer in the local period (R5.2)", () => {
  it("never in the local period, on an empty chat or beside a stalled row", () => {
    expect(showClaudeCodeOffer(true, 0, null, true)).toBe(false);
    expect(showClaudeCodeOffer(true, 1, { kind: "waiting", waitedMs: 10 * 60_000 }, true)).toBe(
      false,
    );
    expect(showClaudeCodeOffer(true, 0, null, false)).toBe(true);
  });
});
