// @vitest-environment happy-dom

/**
 * `useChatState`'s part B hooks (#1123 part B, R1.2, R6.2, R6.3): `onSent`
 * from the send handler, `onNoticeRows` for notice rows arriving live (never
 * history, never `onClaudeReplies`), and notice rows counting as unread.
 * `BYO_MODELS_ENABLED` is flipped on by mocking the constant.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ChatMessage } from "../../src/shared/types";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const { Y_MAP_CHAT } = await import("../../src/shared/constants");
const { default: ChatStateHarness } = await import("./fixtures/ChatStateHarness.svelte");

const notice = (
  id: string,
  kind: ChatMessage["chatNotice"],
  timestamp = Date.now(),
): ChatMessage => ({
  id,
  author: "claude",
  text: `notice ${id}`,
  timestamp,
  read: true,
  chatNotice: kind,
});

afterEach(() => cleanup());

describe("useChatState, flag on", () => {
  it("a notice row arriving live goes to onNoticeRows, never to onClaudeReplies; history to neither", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("old", notice("old", "no-reply", 1));
    const replies: string[] = [];
    const notices: string[] = [];
    const view = render(ChatStateHarness, {
      props: {
        doc,
        synced: true,
        visible: false,
        initialClaudeIds: ["old"],
        onClaudeReplies: (r: ChatMessage[]) => replies.push(...r.map((m) => m.id)),
        onNoticeRows: (n: ChatMessage[]) => notices.push(...n.map((m) => m.id)),
      },
    });
    for (const kind of ["no-document", "no-local-model", "no-reply", "claude-again"] as const) {
      doc.getMap(Y_MAP_CHAT).set(kind, notice(kind, kind));
    }
    doc.getMap(Y_MAP_CHAT).set("reply", { ...notice("reply", undefined), chatNotice: undefined });
    // Rows written in one millisecond sort by id, so compare as a set.
    await waitFor(() =>
      expect([...notices].sort()).toEqual([
        "claude-again",
        "no-document",
        "no-local-model",
        "no-reply",
      ]),
    );
    expect(replies).toEqual(["reply"]);
    // Notice rows count toward the unread count (R6.3).
    await waitFor(() => expect(view.getByTestId("unread").textContent).toBe("5"));
  });

  it("send calls onSent with the row it wrote", async () => {
    const doc = new Y.Doc();
    const sent: ChatMessage[] = [];
    const view = render(ChatStateHarness, {
      props: {
        doc,
        synced: true,
        visible: true,
        sendText: "hello",
        onSent: (m: ChatMessage) => sent.push(m),
      },
    });
    await fireEvent.click(view.getByTestId("send"));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("hello");
    expect(doc.getMap(Y_MAP_CHAT).get(sent[0].id)).toEqual(sent[0]);
  });
});
