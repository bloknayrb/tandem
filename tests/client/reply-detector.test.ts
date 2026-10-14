import { describe, expect, it } from "vitest";
import { createReplyDetector } from "../../src/client/notifications/reply-detector";
import type { ChatMessage } from "../../src/shared/types";

const NOW = 1_000_000;

function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "claude", text: id, timestamp: NOW, read: true, ...extra };
}

function observeIds(
  detector: ReturnType<typeof createReplyDetector>,
  input: {
    doc: object;
    synced?: boolean;
    baselineIds?: string[];
    messages: ChatMessage[];
    streaming?: string[];
  },
): string[] {
  return detector
    .observe({
      doc: input.doc,
      synced: input.synced ?? true,
      baselineIds: input.baselineIds ?? [],
      messages: input.messages,
      streamingIds: new Set(input.streaming ?? []),
    })
    .map((m) => m.id);
}

describe("createReplyDetector (#2168)", () => {
  const make = () => createReplyDetector({ now: () => NOW });

  it("announces nothing before sync, even though the observer already saw history", () => {
    const detector = make();
    const doc = {};
    expect(observeIds(detector, { doc, synced: false, messages: [msg("a"), msg("b")] })).toEqual(
      [],
    );
    // Sync lands; the baseline captured in the provider callback holds both.
    expect(
      observeIds(detector, { doc, baselineIds: ["a", "b"], messages: [msg("a"), msg("b")] }),
    ).toEqual([]);
  });

  it("treats a reply outside the sync baseline as new, even on the first look", () => {
    // The race yjsSync documents: a reply lands between `synced` and the first
    // effect run. It must not be swallowed into the baseline.
    const detector = make();
    expect(
      observeIds(detector, { doc: {}, baselineIds: ["a"], messages: [msg("a"), msg("late")] }),
    ).toEqual(["late"]);
  });

  it("announces each reply once", () => {
    const detector = make();
    const doc = {};
    expect(observeIds(detector, { doc, messages: [msg("a")] })).toEqual(["a"]);
    expect(observeIds(detector, { doc, messages: [msg("a")] })).toEqual([]);
    expect(observeIds(detector, { doc, messages: [msg("a"), msg("b")] })).toEqual(["b"]);
  });

  it("reseeds on a new ctrl doc (server restart) but not on the same doc", () => {
    const detector = make();
    const first = {};
    observeIds(detector, { doc: first, baselineIds: ["a"], messages: [msg("a")] });
    // Restart: a fresh Y.Doc syncs the whole history again.
    const second = {};
    expect(
      observeIds(detector, {
        doc: second,
        baselineIds: ["a", "b"],
        messages: [msg("a"), msg("b")],
      }),
    ).toEqual([]);
  });

  it("skips inProgress acks, user messages and stale replies", () => {
    const detector = make();
    expect(
      observeIds(detector, {
        doc: {},
        messages: [
          msg("ack", { inProgress: true }),
          msg("mine", { author: "user" }),
          msg("old", { timestamp: NOW - 61_000 }),
          msg("answer"),
        ],
      }),
    ).toEqual(["answer"]);
  });

  it("announces a late reply on an already-seeded doc, however old its timestamp", () => {
    // A same-doc reconnect delivers only the delta: a reply that reaches
    // Tandem minutes late after a lost connection is still live news.
    const detector = make();
    const doc = {};
    expect(observeIds(detector, { doc, baselineIds: ["a"], messages: [msg("a")] })).toEqual([]);
    expect(
      observeIds(detector, {
        doc,
        baselineIds: ["a"],
        messages: [msg("a"), msg("late", { timestamp: NOW - 5 * 60_000 })],
      }),
    ).toEqual(["late"]);
  });

  it("drops an old reply outside the baseline when seeding a new doc, and never revives it", () => {
    const detector = make();
    const first = {};
    observeIds(detector, { doc: first, baselineIds: ["a"], messages: [msg("a")] });
    const second = {};
    const old = msg("old", { timestamp: NOW - 5 * 60_000 });
    expect(
      observeIds(detector, { doc: second, baselineIds: ["a"], messages: [msg("a"), old] }),
    ).toEqual([]);
    expect(observeIds(detector, { doc: second, messages: [msg("a"), old] })).toEqual([]);
  });

  it("holds a streaming reply without marking it known, then announces it on finish", () => {
    const detector = make();
    const doc = {};
    expect(observeIds(detector, { doc, messages: [msg("s")], streaming: ["s"] })).toEqual([]);
    expect(observeIds(detector, { doc, messages: [msg("s")] })).toEqual(["s"]);
  });
});
