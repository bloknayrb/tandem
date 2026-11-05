// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  MAX_REPLY_SEEN_ENTRIES,
  type ThreadAnswers,
} from "../../src/client/hooks/useThreadAnswers.svelte";
import {
  createChatAttention,
  type NotifierBackend,
} from "../../src/client/notifications/chat-attention";
import {
  buildCommentNotificationText,
  type CommentAnswerItem,
  toCommentAnswerItem,
} from "../../src/client/notifications/comment-attention";
import type { ThreadAnswer } from "../../src/client/notifications/thread-answer-detector";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_REPLY_SEEN,
  Y_MAP_REPLY_SEEN_WATERMARK,
} from "../../src/shared/constants";
import type { AnnotationReply } from "../../src/shared/types";
import ThreadAnswersHarness from "./fixtures/ThreadAnswersHarness.svelte";

const NOW = 5_000_000;

function userCard(ydoc: Y.Doc, id = "card", status = "pending"): void {
  ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
    id,
    type: "comment",
    author: "user",
    audience: "outbound",
    status,
    content: "?",
    range: { from: 0, to: 1 },
    timestamp: 0,
  });
}

function addAnswer(ydoc: Y.Doc, id: string, timestamp: number, annotationId = "card"): void {
  const reply: AnnotationReply = { id, annotationId, author: "claude", text: id, timestamp };
  ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, reply);
}

/** Two replicas kept in sync, as two windows' providers would. */
function bridge(a: Y.Doc, b: Y.Doc): () => void {
  const ab = (u: Uint8Array, origin: unknown) =>
    origin !== "bridge" && Y.applyUpdate(b, u, "bridge");
  const ba = (u: Uint8Array, origin: unknown) =>
    origin !== "bridge" && Y.applyUpdate(a, u, "bridge");
  a.on("update", ab);
  b.on("update", ba);
  return () => {
    a.off("update", ab);
    b.off("update", ba);
  };
}

function mount(props: {
  tabs: { id: string; ydoc: Y.Doc }[];
  ctrl: Y.Doc;
  activeDocumentId?: string | null;
  windowActive?: boolean;
  onAnswers?: (answers: ThreadAnswer[]) => void;
  capturedAt?: number;
}): ThreadAnswers {
  let ready: ThreadAnswers | null = null;
  const baselines = new Map(
    props.tabs.map((tab) => [
      tab.ydoc,
      {
        ids: Array.from(tab.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).keys()),
        capturedAt: props.capturedAt ?? NOW,
      },
    ]),
  );
  render(ThreadAnswersHarness, {
    props: {
      ...props,
      baselines,
      onReady: (answers: ThreadAnswers) => {
        ready = answers;
      },
    },
  });
  if (!ready) throw new Error("harness did not hand back its ThreadAnswers");
  return ready;
}

describe("createThreadAnswers (#2360)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("announces an answer in a BACKGROUND document, not only the active one", async () => {
    const active = new Y.Doc();
    const background = new Y.Doc();
    userCard(background);
    const onAnswers = vi.fn();
    mount({
      tabs: [
        { id: "active", ydoc: active },
        { id: "background", ydoc: background },
      ],
      ctrl: new Y.Doc(),
      activeDocumentId: "active",
      onAnswers,
    });
    addAnswer(background, "rpl_1", NOW + 10);
    await waitFor(() => expect(onAnswers).toHaveBeenCalledTimes(1));
    expect(onAnswers.mock.calls[0][0]).toEqual([
      expect.objectContaining({ documentId: "background", annotationId: "card", replyId: "rpl_1" }),
    ]);
  });

  it("does not announce what was there at sync, and announces a live one once", async () => {
    const doc = new Y.Doc();
    userCard(doc);
    addAnswer(doc, "old", NOW - 10);
    const onAnswers = vi.fn();
    mount({ tabs: [{ id: "d", ydoc: doc }], ctrl: new Y.Doc(), onAnswers });
    addAnswer(doc, "new", NOW + 10);
    await waitFor(() => expect(onAnswers).toHaveBeenCalledTimes(1));
    // Re-observed many times (an unrelated annotation edit): still once.
    userCard(doc, "other");
    await new Promise((r) => setTimeout(r, 20));
    expect(onAnswers).toHaveBeenCalledTimes(1);
    expect(onAnswers.mock.calls[0][0].map((a: ThreadAnswer) => a.replyId)).toEqual(["new"]);
  });

  it("seeds the watermark at first sync, so history reads seen and a later answer reads new", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const doc = new Y.Doc();
    const ctrl = new Y.Doc();
    userCard(doc);
    addAnswer(doc, "history", NOW - 1_000);
    const answers = mount({ tabs: [{ id: "d", ydoc: doc }], ctrl });
    await waitFor(() =>
      expect(ctrl.getMap(Y_MAP_REPLY_SEEN).get(Y_MAP_REPLY_SEEN_WATERMARK)).toBe(NOW),
    );
    expect(answers.unseenAnswerIds("d", "card")).toEqual([]);
    addAnswer(doc, "fresh", NOW + 1);
    await waitFor(() => expect(answers.unseenAnswerIds("d", "card")).toEqual(["fresh"]));
  });

  it("a resolved comment never holds an unseen marker", async () => {
    const doc = new Y.Doc();
    const ctrl = new Y.Doc();
    ctrl.getMap(Y_MAP_REPLY_SEEN).set(Y_MAP_REPLY_SEEN_WATERMARK, 0);
    userCard(doc, "card", "accepted");
    addAnswer(doc, "a", NOW + 1);
    const answers = mount({ tabs: [{ id: "d", ydoc: doc }], ctrl });
    await new Promise((r) => setTimeout(r, 10));
    expect(answers.unseenAnswerIds("d", "card")).toEqual([]);
  });

  it("markSeen writes only real answers, only while the window is active", async () => {
    const doc = new Y.Doc();
    const ctrl = new Y.Doc();
    ctrl.getMap(Y_MAP_REPLY_SEEN).set(Y_MAP_REPLY_SEEN_WATERMARK, 0);
    userCard(doc);
    addAnswer(doc, "a", NOW + 1);
    doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("mine", {
      id: "mine",
      annotationId: "card",
      author: "user",
      text: "x",
      timestamp: NOW + 2,
    });
    const away = mount({ tabs: [{ id: "d", ydoc: doc }], ctrl, windowActive: false });
    await waitFor(() => expect(away.unseenAnswerIds("d", "card")).toEqual(["a"]));
    away.markSeen("d", ["a"]);
    expect(ctrl.getMap(Y_MAP_REPLY_SEEN).has("a")).toBe(false);
    cleanup();

    const here = mount({ tabs: [{ id: "d", ydoc: doc }], ctrl, windowActive: true });
    await waitFor(() => expect(here.unseenAnswerIds("d", "card")).toEqual(["a"]));
    here.markSeen("d", ["a", "mine", "not-a-reply"]);
    expect(ctrl.getMap(Y_MAP_REPLY_SEEN).toJSON()).toEqual({
      [Y_MAP_REPLY_SEEN_WATERMARK]: 0,
      a: NOW + 1,
    });
    await waitFor(() => expect(here.unseenAnswerIds("d", "card")).toEqual([]));
  });

  it("the cap drops the oldest entries and raises the watermark past them", async () => {
    const doc = new Y.Doc();
    const ctrl = new Y.Doc();
    const seen = ctrl.getMap(Y_MAP_REPLY_SEEN);
    seen.set(Y_MAP_REPLY_SEEN_WATERMARK, 0);
    for (let i = 0; i < MAX_REPLY_SEEN_ENTRIES; i++) seen.set(`old-${i}`, 100 + i);
    userCard(doc);
    addAnswer(doc, "a", NOW + 1);
    const answers = mount({ tabs: [{ id: "d", ydoc: doc }], ctrl });
    await waitFor(() => expect(answers.unseenAnswerIds("d", "card")).toEqual(["a"]));
    answers.markSeen("d", ["a"]);
    expect(seen.has("old-0")).toBe(false);
    expect(seen.has("old-1")).toBe(true);
    expect(seen.get(Y_MAP_REPLY_SEEN_WATERMARK)).toBe(101);
    expect(seen.size).toBe(MAX_REPLY_SEEN_ENTRIES + 1);
    // The dropped entry still reads seen through the watermark.
    expect(answers.isSeen("old-0", 100)).toBe(true);
  });

  it("two windows: an away window announces once, and stays quiet when the other showed it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const scenario = async (otherWindowShowsIt: boolean) => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const ctrlA = new Y.Doc();
      const ctrlB = new Y.Doc();
      const unbridge = [bridge(docA, docB), bridge(ctrlA, ctrlB)];
      ctrlA.getMap(Y_MAP_REPLY_SEEN).set(Y_MAP_REPLY_SEEN_WATERMARK, 0);
      userCard(docA);
      const backend = {
        notify: vi.fn<NotifierBackend["notify"]>(),
        attention: vi.fn<NotifierBackend["attention"]>(),
        clearAttention: vi.fn<NotifierBackend["clearAttention"]>(),
      };
      let windowB: ThreadAnswers | null = null;
      const dispatcherB = createChatAttention<CommentAnswerItem>({
        getSettings: () => ({
          chatNotifications: true,
          chatNotificationContent: "generic",
          chatAttentionFlash: true,
          chatSound: "chime",
          chatSoundVolume: 0,
        }),
        isActive: () => false,
        isSeen: (id, item) => windowB?.isSeen(id, item.timestamp) ?? false,
        documentName: () => null,
        backend,
        playChime: () => {},
        buildText: buildCommentNotificationText,
        openTarget: () => {},
      });
      const windowA = mount({ tabs: [{ id: "d", ydoc: docA }], ctrl: ctrlA, windowActive: true });
      windowB = mount({
        tabs: [{ id: "d", ydoc: docB }],
        ctrl: ctrlB,
        windowActive: false,
        onAnswers: (answers) => dispatcherB.push(answers.map(toCommentAnswerItem)),
      });
      addAnswer(docA, "rpl_live", NOW + 1);
      await vi.advanceTimersByTimeAsync(0);
      if (otherWindowShowsIt) windowA.markSeen("d", ["rpl_live"]);
      // B's coalescing window runs out.
      await vi.advanceTimersByTimeAsync(800);
      for (const off of unbridge) off();
      cleanup();
      dispatcherB.destroy();
      return backend.notify.mock.calls.length;
    };
    // Positive anchor: nobody showed it, so the away window announces it, once.
    expect(await scenario(false)).toBe(1);
    // Window A showed the card: the shared seen map silences B.
    expect(await scenario(true)).toBe(0);
  });
});
