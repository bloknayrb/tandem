import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatAttentionSettings,
  createChatAttention,
  type NotifierBackend,
} from "../../src/client/notifications/chat-attention";
import {
  buildCommentNotificationText,
  type CommentAnswerItem,
  combineAttention,
  type PendingReveal,
  resolvePendingReveal,
  routeNotificationActivation,
  toCommentAnswerItem,
} from "../../src/client/notifications/comment-attention";

const names = (id: string) => (id === "doc-1" ? "report.md" : id === "doc-2" ? "notes.md" : null);

function item(id: string, extra: Partial<CommentAnswerItem> = {}): CommentAnswerItem {
  return {
    id,
    author: "claude",
    text: `**Yes** — ${id}`,
    timestamp: 1,
    read: false,
    documentId: "doc-1",
    annotationId: `ann-${id}`,
    ...extra,
  };
}

describe("buildCommentNotificationText (#2360)", () => {
  it("says it is a reply to the user's comment, naming the file only when allowed", () => {
    expect(buildCommentNotificationText([item("a")], "generic", names)).toEqual({
      title: "Claude replied to your comment",
      body: "",
    });
    expect(buildCommentNotificationText([item("a")], "document", names)).toEqual({
      title: "Claude replied to your comment in report.md",
      body: "",
    });
    expect(buildCommentNotificationText([item("a")], "preview", names)).toEqual({
      title: "Claude replied to your comment in report.md",
      body: "Yes — a",
    });
  });

  it("counts a batch and names no file when it spans two documents", () => {
    expect(buildCommentNotificationText([item("a"), item("b")], "document", names).title).toBe(
      "Claude sent 2 replies to your comments in report.md",
    );
    expect(
      buildCommentNotificationText(
        [item("a"), item("b", { documentId: "doc-2" })],
        "document",
        names,
      ).title,
    ).toBe("Claude sent 2 replies to your comments");
  });

  it("cleans a file name's bidi controls", () => {
    const sneaky = (id: string) => (id === "doc-1" ? "report\u202Edm.exe" : null);
    expect(buildCommentNotificationText([item("a")], "document", sneaky).title).toBe(
      "Claude replied to your comment in reportdm.exe",
    );
  });
});

describe("toCommentAnswerItem", () => {
  it("keys the item by reply id and keeps the annotation to open", () => {
    expect(
      toCommentAnswerItem({
        documentId: "doc-1",
        annotationId: "ann_1",
        replyId: "rpl_1",
        text: "t",
        timestamp: 5,
      }),
    ).toMatchObject({ id: "rpl_1", documentId: "doc-1", annotationId: "ann_1", author: "claude" });
  });
});

function fakeBackend() {
  return {
    notify: vi.fn<NotifierBackend["notify"]>(),
    attention: vi.fn<NotifierBackend["attention"]>(),
    clearAttention: vi.fn<NotifierBackend["clearAttention"]>(),
  };
}

describe("combineAttention (#2360)", () => {
  it("shows the sum of both counts and passes each view's kind to notify", () => {
    const real = fakeBackend();
    const { chat, comment } = combineAttention(real);
    chat.attention(1);
    comment.attention(2);
    expect(real.attention).toHaveBeenLastCalledWith(3);
    const onClick = () => {};
    comment.notify({ title: "t", body: "" }, onClick);
    chat.notify({ title: "c", body: "" }, onClick);
    expect(real.notify).toHaveBeenNthCalledWith(1, { title: "t", body: "" }, onClick, "comment");
    expect(real.notify).toHaveBeenNthCalledWith(2, { title: "c", body: "" }, onClick, "chat");
  });

  it.each([
    ["chat first", ["chat", "comment"] as const],
    ["comment first", ["comment", "chat"] as const],
  ])("clears exactly once and never re-flashes when both reset (%s)", (_, order) => {
    const real = fakeBackend();
    const views = combineAttention(real);
    views.chat.attention(1);
    views.comment.attention(2);
    real.attention.mockClear();
    views[order[0]].clearAttention();
    views[order[1]].clearAttention();
    expect(real.attention).not.toHaveBeenCalled();
    expect(real.clearAttention).toHaveBeenCalledTimes(1);
  });

  it("keeps the other kind's count after one view clears", () => {
    const real = fakeBackend();
    const { chat, comment } = combineAttention(real);
    chat.attention(2);
    comment.attention(1);
    comment.clearAttention();
    expect(real.clearAttention).not.toHaveBeenCalled();
    chat.attention(3);
    expect(real.attention).toHaveBeenLastCalledWith(3);
  });
});

describe("routeNotificationActivation (#2360)", () => {
  it("sends a comment click to comments and everything else to chat", () => {
    const calls: string[] = [];
    const targets = { chat: () => calls.push("chat"), comment: () => calls.push("comment") };
    routeNotificationActivation("comment", targets);
    routeNotificationActivation("chat", targets);
    routeNotificationActivation(undefined, targets);
    routeNotificationActivation(null, targets);
    routeNotificationActivation({ kind: "comment" }, targets);
    expect(calls).toEqual(["comment", "chat", "chat", "chat", "chat"]);
  });
});

describe("resolvePendingReveal (#2360)", () => {
  const pending: PendingReveal = { documentId: "d", annotationId: "a" };
  const state = (over: Partial<Parameters<typeof resolvePendingReveal>[1]> = {}) => ({
    activeDocumentId: "d",
    openDocumentIds: ["d", "e"],
    hasAnnotation: (id: string) => id === "a",
    ...over,
  });

  it("reveals once the document is active and the annotation has arrived", () => {
    expect(resolvePendingReveal(pending, state())).toBe("reveal");
  });
  it("waits while the tab switch or the annotations are still landing", () => {
    expect(resolvePendingReveal(pending, state({ activeDocumentId: "e" }))).toBe("wait");
    expect(resolvePendingReveal(pending, state({ hasAnnotation: () => false }))).toBe("wait");
  });
  it("drops when the document closed", () => {
    expect(resolvePendingReveal(pending, state({ openDocumentIds: ["e"] }))).toBe("drop");
  });
});

describe("createChatAttention as the comment-answer instance (#2360)", () => {
  const SETTINGS: ChatAttentionSettings = {
    chatNotifications: true,
    chatNotificationContent: "document",
    chatAttentionFlash: true,
    chatSound: "chime",
    chatSoundVolume: 60,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  function setup(seen: (id: string, item: CommentAnswerItem) => boolean = () => false) {
    const backend = fakeBackend();
    const openTarget = vi.fn();
    const isSeen = vi.fn(seen);
    const attention = createChatAttention<CommentAnswerItem>({
      getSettings: () => SETTINGS,
      isActive: () => false,
      isSeen,
      documentName: names,
      backend: combineAttention(backend).comment,
      playChime: () => {},
      buildText: buildCommentNotificationText,
      openTarget,
    });
    return { attention, backend, openTarget, isSeen };
  }

  it("posts its own wording with its kind, and a click opens the newest announced item", () => {
    const t = setup();
    t.attention.push([item("a"), item("b")]);
    vi.advanceTimersByTime(750);
    expect(t.backend.notify).toHaveBeenCalledWith(
      { title: "Claude sent 2 replies to your comments in report.md", body: "" },
      expect.any(Function),
      "comment",
    );
    t.attention.notificationActivated();
    expect(t.openTarget).toHaveBeenCalledWith(expect.objectContaining({ annotationId: "ann-b" }));
  });

  it("hands isSeen the whole item, so the comment check can read its timestamp", () => {
    const t = setup((_, it) => it.timestamp < 10);
    t.attention.push([item("old", { timestamp: 5 }), item("new", { timestamp: 20 })]);
    vi.advanceTimersByTime(750);
    expect(t.isSeen).toHaveBeenCalledWith("old", expect.objectContaining({ timestamp: 5 }));
    expect(t.backend.attention).toHaveBeenCalledWith(1);
  });

  it("a click after the grace hands openTarget undefined", () => {
    const t = setup();
    t.attention.push([item("a")]);
    vi.advanceTimersByTime(750);
    t.attention.windowActivated();
    vi.advanceTimersByTime(6_000);
    t.attention.notificationActivated();
    expect(t.openTarget).toHaveBeenCalledWith(undefined);
  });
});
