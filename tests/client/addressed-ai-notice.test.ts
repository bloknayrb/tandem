import { describe, expect, it } from "vitest";
import type { AiChip, PushDelivery } from "../../src/client/hooks/useAiReadiness.svelte";
import { addressedAiNotice } from "../../src/client/status/addressed-ai-notice.js";

/**
 * The decision behind the two `tandem:addressed-ai` notices.
 *
 * The case that motivates the whole module is `no-push`: an agent IS attached
 * (so the old handler returned silently) but nothing delivers to it, so the
 * user's comment waits for the next `tandem_checkInbox` with no feedback at all.
 * "AI connected" is true and says nothing about delivery.
 */

const base = {
  soloMode: false,
  sessionLive: false,
  // `AiChip` already includes `null`; annotating honestly (rather than `as
  // never`) keeps a future widening of that union a type error here.
  chip: null as AiChip,
  pushDelivery: "unknown" as PushDelivery,
};

describe("addressedAiNotice", () => {
  describe("no agent attached", () => {
    it("raises the agent-absence notice carrying the chip to render", () => {
      expect(addressedAiNotice({ ...base, sessionLive: false, chip: "restart" })).toEqual({
        kind: "no-agent",
        chip: "restart",
      });
    });

    it("carries `setup` through rather than collapsing it to a boolean", () => {
      // The chip is passed through, not re-derived: a binary read of this value
      // is exactly how `setup` users were once offered "Restart Claude Code".
      expect(addressedAiNotice({ ...base, sessionLive: false, chip: "setup" })).toEqual({
        kind: "no-agent",
        chip: "setup",
      });
    });

    it("stays silent while readiness has not settled (null chip)", () => {
      // Booting, and the launcher's running-but-no-session startup window.
      expect(addressedAiNotice({ ...base, sessionLive: false, chip: null })).toBeNull();
    });
  });

  describe("agent attached", () => {
    it("raises the delivery notice when no consumer is attached", () => {
      expect(
        addressedAiNotice({
          ...base,
          sessionLive: true,
          chip: null,
          pushDelivery: "none",
        }),
      ).toEqual({ kind: "no-push" });
    });

    it("stays silent when a consumer IS attached", () => {
      expect(
        addressedAiNotice({
          ...base,
          sessionLive: true,
          chip: null,
          pushDelivery: "attached",
        }),
      ).toBeNull();
    });

    it("stays silent when the consumer count is unknown", () => {
      // `null` is not zero. A redacted or unread field must never be reported
      // as "nothing is delivering" — that would tell a working user their
      // comment went nowhere.
      expect(
        addressedAiNotice({
          ...base,
          sessionLive: true,
          chip: null,
          pushDelivery: "unknown",
        }),
      ).toBeNull();
    });

    it("prefers the delivery notice over a stale non-null chip", () => {
      // A live session outranks a chip that has not caught up yet: the agent is
      // demonstrably there, so "no AI is connected" would be the wrong story.
      expect(
        addressedAiNotice({
          ...base,
          sessionLive: true,
          chip: "restart",
          pushDelivery: "none",
        }),
      ).toEqual({ kind: "no-push" });
    });
  });

  describe("Solo mode", () => {
    // Solo outranks both branches — the user opted out of AI surfacing, so
    // either notice contradicts that intent.
    it.each([
      [
        "no agent",
        { sessionLive: false, chip: "restart" as const, pushDelivery: "unknown" as PushDelivery },
      ],
      ["no consumer", { sessionLive: true, chip: null, pushDelivery: "none" as PushDelivery }],
      [
        "everything healthy",
        { sessionLive: true, chip: null, pushDelivery: "attached" as PushDelivery },
      ],
    ])("stays silent in Solo (%s)", (_label, rest) => {
      expect(addressedAiNotice({ ...base, ...rest, soloMode: true })).toBeNull();
    });
  });
});
