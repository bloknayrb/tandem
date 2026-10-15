import { describe, expect, it } from "vitest";
import type { AiChip, PushDelivery } from "../../src/client/hooks/useAiReadiness.svelte";
import {
  type AddressedAiNotice,
  addressedAiNotice,
  noticeAction,
} from "../../src/client/status/addressed-ai-notice.js";

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
  // The healthy default: the probe reached our server. Cases that exercise the
  // unanswered path set it explicitly, so every other test keeps reading as a
  // statement about the branch it names.
  probeAnswered: true,
  sessionLive: false,
  // `AiChip` already includes `null`; annotating honestly (rather than `as
  // never`) keeps a future widening of that union a type error here.
  chip: null as AiChip,
  pushDelivery: "unknown" as PushDelivery,
  startingForMessage: false,
};

describe("addressedAiNotice", () => {
  describe("a chat that is starting Tandem's Claude (#2196)", () => {
    it("raises no notice — the chat panel's resume row speaks for it", () => {
      const inputs = { ...base, chip: "start" as AiChip };
      // Control: the same send without the start gets the no-agent notice.
      expect(addressedAiNotice(inputs)).toEqual({ kind: "no-agent", chip: "start" });
      expect(addressedAiNotice({ ...inputs, startingForMessage: true })).toBeNull();
    });

    it("still reports a server that has gone away", () => {
      expect(
        addressedAiNotice({ ...base, serverUnreachable: true, startingForMessage: true }),
      ).toEqual({ kind: "offline" });
    });
  });

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

  describe("an unanswered probe", () => {
    // The gap: a hand-launched session never takes the caller's fast path, so
    // every send probes. If the server has just died that probe fails,
    // `probeSession` falls back to the last polled `true`, and probe reads
    // deliberately do not accrue strikes — so `serverUnreachable` is still
    // false and the offline branch cannot catch it. Before this rule the user
    // was told "Claude is connected but isn't being notified" on the strength
    // of a read that had failed a millisecond earlier.
    it("suppresses no-push, because that is the branch asserting connectivity", () => {
      const inputs = {
        ...base,
        sessionLive: true, // stale — the fallback, not a confirmation
        chip: null,
        pushDelivery: "none" as PushDelivery,
      };
      // The control: with the same inputs and an answered probe, it fires.
      expect(addressedAiNotice(inputs)).toEqual({ kind: "no-push" });
      expect(addressedAiNotice({ ...inputs, probeAnswered: false })).toBeNull();
    });

    it("does NOT suppress no-agent — that branch rests on the launcher route", () => {
      // `chip` comes from `/api/launcher/status`, which carries its own
      // independent strike floor. An unrelated route blipping is no reason to
      // withhold a notice this one supports, and the copy it produces ("saved
      // while no AI was connected") stays true regardless.
      expect(
        addressedAiNotice({
          ...base,
          probeAnswered: false,
          sessionLive: false,
          chip: "restart",
          pushDelivery: "unknown",
        }),
      ).toEqual({ kind: "no-agent", chip: "restart" });
    });

    it("does NOT suppress offline — a met strike floor outranks a single read", () => {
      // `serverUnreachable` is only set after a full run of dead POLLS, which
      // is strictly stronger evidence than the one failed probe that got us
      // here. Ordering this gate above rule 2 would discard the stronger signal
      // for the weaker one.
      expect(
        addressedAiNotice({
          ...base,
          probeAnswered: false,
          serverUnreachable: true,
          sessionLive: true,
          chip: null,
          pushDelivery: "none",
        }),
      ).toEqual({ kind: "offline" });
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

/**
 * #1521: the licence refusal. Without its own arm, `no-agent` would promise the
 * message "will be seen when one connects" — but nothing can connect until a
 * license is activated.
 */
describe("addressedAiNotice — licence refusal", () => {
  it("the ai-off chip gives ai-off", () => {
    expect(addressedAiNotice({ ...base, chip: "ai-off" })).toEqual({ kind: "ai-off" });
  });

  it("Solo still outranks it, and an unreachable server still reads offline", () => {
    expect(addressedAiNotice({ ...base, chip: "ai-off", soloMode: true })).toBeNull();
    expect(addressedAiNotice({ ...base, chip: "ai-off", serverUnreachable: true })).toEqual({
      kind: "offline",
    });
  });

  it("the twin: a restart chip is still no-agent", () => {
    expect(addressedAiNotice({ ...base, chip: "restart" })).toEqual({
      kind: "no-agent",
      chip: "restart",
    });
  });
});

/**
 * `noticeAction` is the pure, exhaustive toast table App pushes from (#1521).
 * Each kind yields its own descriptor; `ai-off` must not fall into `no-push`.
 */
describe("noticeAction", () => {
  const act = (n: AddressedAiNotice) => noticeAction(n, "Message");

  it("offline: a warning with no CTA", () => {
    const t = act({ kind: "offline" });
    expect(t.idPrefix).toBe("ai-offline");
    expect(t.severity).toBe("warning");
    expect(t.cta).toBeNull();
  });

  it("ai-off: the ai-off CTA, and copy naming neither kind", () => {
    const t = act({ kind: "ai-off" });
    expect(t.idPrefix).toBe("ai-off");
    expect(t.severity).toBe("warning");
    expect(t.cta).toBe("ai-off");
    expect(t.message).not.toMatch(/unlicensed/i);
    expect(t.message).not.toMatch(/activate/i);
    expect(t.message).toContain("Settings → License");
  });

  it("no-agent: carries its chip", () => {
    const t = act({ kind: "no-agent", chip: "setup" });
    expect(t.idPrefix).toBe("ai-not-ready");
    expect(t.cta).toBe("setup");
  });

  it("no-agent with the start chip (#2195): says nothing will answer until Start, not 'when one connects'", () => {
    const t = act({ kind: "no-agent", chip: "start" });
    expect(t.cta).toBe("start");
    expect(t.message).toContain("nothing will answer until you start it");
    expect(t.message).not.toContain("when one connects");
    // Control: any other chip keeps the connect copy.
    expect(act({ kind: "no-agent", chip: "restart" }).message).toContain("when one connects");
  });

  it("no-push: info, no CTA", () => {
    const t = act({ kind: "no-push" });
    expect(t.idPrefix).toBe("ai-no-push");
    expect(t.severity).toBe("info");
    expect(t.cta).toBeNull();
  });

  it("every kind has a distinct id prefix", () => {
    const prefixes = (
      [
        { kind: "offline" },
        { kind: "ai-off" },
        { kind: "no-agent", chip: "restart" },
        { kind: "no-push" },
      ] as AddressedAiNotice[]
    ).map((n) => act(n).idPrefix);
    expect(new Set(prefixes).size).toBe(4);
  });
});
