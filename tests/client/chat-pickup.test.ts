import { describe, expect, it } from "vitest";
import {
  chatPickup,
  chatPickupAnnouncement,
  chatPickupLabel,
  PICKUP_MAX_AGE_MS,
} from "../../src/client/panels/chat-pickup";
import { DELIVERY_STALL_MS } from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";

const T0 = 1_800_000_000_000;

function user(id: string, at: number, read = false): ChatMessage {
  return { id, author: "user", text: id, timestamp: T0 + at, read };
}

function claude(
  id: string,
  at: number,
  extra: { replyTo?: string; inProgress?: true } = {},
): ChatMessage {
  return { id, author: "claude", text: id, timestamp: T0 + at, read: true, ...extra };
}

describe("chatPickup", () => {
  it("says nothing with no user message", () => {
    expect(chatPickup([], T0)).toBeNull();
    expect(chatPickup([claude("c", 0)], T0)).toBeNull();
  });

  it("is waiting while unread, with the elapsed time from the message", () => {
    expect(chatPickup([user("a", 0)], T0 + 5_000)).toEqual({ kind: "waiting", waitedMs: 5_000 });
  });

  it("is received once the inbox stamps it read", () => {
    expect(chatPickup([user("a", 0, true)], T0 + 5_000)).toEqual({ kind: "received" });
  });

  it("is working after an inProgress ack, and clears on the result", () => {
    const ack = claude("ack", 1_000, { replyTo: "a", inProgress: true });
    expect(chatPickup([user("a", 0, true), ack], T0 + 2_000)).toEqual({ kind: "working" });
    const result = claude("res", 3_000, { replyTo: "a" });
    expect(chatPickup([user("a", 0, true), ack, result], T0 + 4_000)).toBeNull();
  });

  it("clears on a single reply that answers without inProgress", () => {
    const reply = claude("r", 1_000, { replyTo: "a" });
    expect(chatPickup([user("a", 0, true), reply], T0 + 2_000)).toBeNull();
  });

  it("ends working on a result sent without replyTo", () => {
    const ack = claude("ack", 1_000, { replyTo: "a", inProgress: true });
    const untagged = claude("res", 3_000);
    expect(chatPickup([user("a", 0, true), ack, untagged], T0 + 4_000)).toBeNull();
  });

  it("ends working on a result stamped in the ack's millisecond", () => {
    const ack = claude("ack", 1_000, { replyTo: "a", inProgress: true });
    const result = claude("res", 1_000, { replyTo: "a" });
    expect(chatPickup([user("a", 0, true), ack, result], T0 + 2_000)).toBeNull();
  });

  it("treats a replyTo naming no user message as untagged", () => {
    const stray = claude("c", 1_000, { replyTo: "not-a-message" });
    expect(chatPickup([user("a", 0), stray], T0 + 2_000)).toBeNull();
  });

  it("keeps working while only further acks arrive", () => {
    const ack = claude("ack", 1_000, { replyTo: "a", inProgress: true });
    const again = claude("ack2", 2_000, { replyTo: "a", inProgress: true });
    expect(chatPickup([user("a", 0, true), ack, again], T0 + 3_000)).toEqual({ kind: "working" });
  });

  it("does not let a reply to an earlier message clear the latest", () => {
    const msgs = [user("a", 0, true), user("b", 1_000), claude("r", 2_000, { replyTo: "a" })];
    expect(chatPickup(msgs, T0 + 3_000)).toEqual({ kind: "waiting", waitedMs: 2_000 });
  });

  it("makes no claim when an untagged Claude message follows, read or not", () => {
    expect(chatPickup([user("a", 0), claude("c", 1_000)], T0 + 2_000)).toBeNull();
    expect(chatPickup([user("a", 0, true), claude("c", 1_000)], T0 + 2_000)).toBeNull();
  });

  it("ignores Claude messages from before the user message", () => {
    expect(chatPickup([claude("c", 0), user("a", 1_000)], T0 + 2_000)).toEqual({
      kind: "waiting",
      waitedMs: 1_000,
    });
  });

  it("never resurrects an older message once the latest is answered", () => {
    const msgs = [user("a", 0, true), user("b", 1_000, true), claude("r", 2_000, { replyTo: "b" })];
    expect(chatPickup(msgs, T0 + 3_000)).toBeNull();
  });

  it("retires the row at the age cap", () => {
    expect(chatPickup([user("a", 0)], T0 + PICKUP_MAX_AGE_MS)).not.toBeNull();
    expect(chatPickup([user("a", 0)], T0 + PICKUP_MAX_AGE_MS + 1)).toBeNull();
    const ack = claude("ack", 1_000, { replyTo: "a", inProgress: true });
    expect(chatPickup([user("a", 0, true), ack], T0 + PICKUP_MAX_AGE_MS + 1)).toBeNull();
  });
});

describe("chatPickupLabel", () => {
  it("adds the elapsed time after 10 s and drops it at the stall threshold", () => {
    expect(chatPickupLabel({ kind: "waiting", waitedMs: 9_000 })).toBe(
      "Sent · waiting for your AI to pick it up",
    );
    expect(chatPickupLabel({ kind: "waiting", waitedMs: 12_400 })).toBe(
      "Sent · waiting for your AI to pick it up · 12 s",
    );
    expect(chatPickupLabel({ kind: "waiting", waitedMs: 75_000 })).toBe(
      "Sent · waiting for your AI to pick it up · 1 min",
    );
    expect(chatPickupLabel({ kind: "waiting", waitedMs: DELIVERY_STALL_MS })).toBe(
      "Sent · still waiting for your AI",
    );
  });

  it("names the received and working states", () => {
    expect(chatPickupLabel({ kind: "received" })).toBe("Your AI has your message");
    expect(chatPickupLabel({ kind: "working" })).toBe("Your AI is working on it");
  });
});

describe("chatPickupAnnouncement", () => {
  it("is keyed on the kind alone and empty with no row", () => {
    expect(chatPickupAnnouncement("waiting")).toBe("Sent · waiting for your AI to pick it up");
    expect(chatPickupAnnouncement(null)).toBe("");
  });
});
