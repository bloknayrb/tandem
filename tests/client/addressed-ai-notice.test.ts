import { describe, expect, it } from "vitest";
import type { AiChip, PushDelivery } from "../../src/client/hooks/useAiReadiness.svelte";
import { addressedAiNotice } from "../../src/client/status/addressed-ai-notice.js";

/**
 * The decision behind the three `tandem:addressed-ai` notices.
 *
 * The case that motivates the whole module is `no-push`: an agent IS attached
 * (so the old handler returned silently) but nothing delivers to it, so the
 * user's comment waits for the next `tandem_checkInbox` with no feedback at all.
 * "AI connected" is true and says nothing about delivery.
 *
 * `offline` was added later, and for the opposite reason: it is the case that
 * produced NO notice at all. With the server gone `chip` is null (state is
 * `booting`), so the agent-absence branch fell into its own null-chip hole and
 * returned silently — a send into a dead server said nothing.
 */

const base = {
  soloMode: false,
  serverUnreachable: false,
  sessionLive: false,
  // `AiChip` already includes `null`; annotating honestly (rather than `as
  // never`) keeps a future widening of that union a type error here.
  chip: null as AiChip,
  pushDelivery: "unknown" as PushDelivery,
};

describe("addressedAiNotice", () => {
  describe("server unreachable", () => {
    it("reports the server, not the AI, and does so through the null-chip hole", () => {
      // The exact production shape: server gone → `connected()` false → state
      // `booting` → `chip` null → `sessionLive` false. Every AI-shaped branch
      // reads this as "no agent" and the null-chip guard then silences it.
      expect(
        addressedAiNotice({ ...base, serverUnreachable: true, sessionLive: false, chip: null }),
      ).toEqual({ kind: "offline" });
    });

    it("outranks the agent-absence notice even when a chip is available", () => {
      // Ordering is the whole point. `sessionLive` is false when the server is
      // gone, but only as a CONSEQUENCE — reporting "no AI is connected, it'll
      // be seen when one connects" would be a second false promise, and this
      // time about a message that may not survive the reconnect at all.
      expect(
        addressedAiNotice({
          ...base,
          serverUnreachable: true,
          sessionLive: false,
          chip: "restart",
        }),
      ).toEqual({ kind: "offline" });
    });

    it("outranks the delivery notice too", () => {
      // Belt-and-braces: `sessionLive` cannot really be true with the server
      // gone, but the rule must not depend on that being impossible.
      expect(
        addressedAiNotice({
          ...base,
          serverUnreachable: true,
          sessionLive: true,
          pushDelivery: "none",
        }),
      ).toEqual({ kind: "offline" });
    });

    it("stays silent in Solo — the user opted out of all of this", () => {
      expect(
        addressedAiNotice({ ...base, soloMode: true, serverUnreachable: true, chip: "restart" }),
      ).toBeNull();
    });
  });

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
