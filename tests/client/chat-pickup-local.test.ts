/**
 * The pickup row for a message a local model handles (#1123 part B, R5.1),
 * with `BYO_MODELS_ENABLED` flipped on by mocking the constant. Every row of
 * the brief's table, in order. The Claude-side rows are `chat-pickup.test.ts`
 * (flag at its shipped value), unchanged.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const {
  chatPickup,
  chatPickupAnnouncement,
  chatPickupLabel,
  isPickupStalled,
  LOCAL_RUN_UNJUDGED_MAX_MS,
  PICKUP_MAX_AGE_MS,
} = await import("../../src/client/panels/chat-pickup");
const { DEFAULT_RUN_DEADLINE_MS } = await import("../../src/shared/local-run");

import type { ChatMessage, LocalRunState } from "../../src/shared/types";

const T0 = 1_800_000_000_000;
const G = "gen-now";

function user(id: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "user", text: id, timestamp: T0 + at, read: false, ...extra };
}
function claude(id: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "claude", text: id, timestamp: T0 + at, read: true, ...extra };
}
const run = (r: Omit<LocalRunState, "generation"> & { generation?: string }): LocalRunState => ({
  generation: G,
  ...r,
});
const inputs = (over: Partial<Parameters<typeof chatPickup>[2] & object> = {}) => ({
  runGeneration: G,
  sentLocal: new Set<string>(),
  readKnownLocal: true,
  aiOff: false,
  ...over,
});
const at = T0 + 5_000;

describe("the local rows, in order (R5.1)", () => {
  it("interrupted (a running state from an earlier process), with or without a row: its own line", () => {
    const m = user("u", 0, { localRun: run({ status: "running", generation: "old" }) });
    expect(chatPickup([m], at, inputs())).toEqual({ kind: "local-interrupted" });
    // A row a restart folded from its sidecar (part C, R4) stays beside it.
    const folded = claude("r", 1, {
      replyTo: "u",
      agentIdentity: { provider: "local-ollama", displayName: "M" },
    });
    expect(chatPickup([m, folded], at, inputs())).toEqual({ kind: "local-interrupted" });
    expect(chatPickupLabel({ kind: "local-interrupted" })).toBe(
      "Tandem restarted while your local model was working on this.",
    );
  });

  it("running, run id not known: working before the deadline plus a minute, nothing after", () => {
    const m = user("u", 0, { localRun: run({ status: "running" }) });
    const unknownGen = inputs({ runGeneration: null });
    expect(LOCAL_RUN_UNJUDGED_MAX_MS).toBe(DEFAULT_RUN_DEADLINE_MS + 60_000);
    expect(chatPickup([m], T0 + LOCAL_RUN_UNJUDGED_MAX_MS, unknownGen)).toEqual({
      kind: "local-working",
    });
    expect(chatPickup([m], T0 + LOCAL_RUN_UNJUDGED_MAX_MS + 1, unknownGen)).toBeNull();
    // A judged running state is not cut by the deadline (only by the age cap).
    expect(chatPickup([m], T0 + LOCAL_RUN_UNJUDGED_MAX_MS + 1, inputs())).toEqual({
      kind: "local-working",
    });
  });

  it("running: B2's working line, with dots (the panel's job), never 'waiting', never the offer", () => {
    const m = user("u", 0, { localRun: run({ status: "running" }) });
    const p = chatPickup([m], at, inputs());
    expect(p).toEqual({ kind: "local-working" });
    expect(chatPickupLabel({ kind: "local-working" })).toBe("Your local model is working on this…");
    expect(isPickupStalled(p)).toBe(false);
  });

  it("replied: the row ends", () => {
    const m = user("u", 0, { localRun: run({ status: "replied", replyId: "r" }) });
    expect(chatPickup([m, claude("r", 1, { replyTo: "u" })], at, inputs())).toBeNull();
  });

  it("stopped with a reply row (partial) or a notice row for it: the row ends", () => {
    const m = user("u", 0, {
      localRun: run({ status: "stopped", reason: "timeout", replyId: "r" }),
    });
    expect(chatPickup([m, claude("r", 1)], at, inputs())).toBeNull();
    const n = user("u", 0, { localRun: run({ status: "stopped", reason: "no-reply" }) });
    const notice = claude("n", 1, { replyTo: "u", chatNotice: "no-reply" });
    expect(chatPickup([n, notice], at, inputs())).toBeNull();
  });

  it("stopped, no reply row and no notice row: 'stopped without answering', whatever the reason, toast or no toast", () => {
    for (const reason of [
      "timeout",
      "error",
      "editing-off",
      "solo",
      "step-limit",
      "aborted",
      "no-reply",
    ] as const) {
      const m = user("u", 0, { localRun: run({ status: "stopped", reason }) });
      expect(chatPickup([m], at, inputs()), reason).toEqual({ kind: "local-stopped" });
    }
    expect(chatPickupLabel({ kind: "local-stopped" })).toBe(
      "Your local model stopped without answering.",
    );
    // A notice for ANOTHER message does not end it.
    const m = user("u", 10, { localRun: run({ status: "stopped", reason: "error" }) });
    const other = claude("n", 11, { replyTo: "earlier", chatNotice: "no-reply" });
    expect(chatPickup([user("earlier", 0), m, other], T0 + 20, inputs())).toEqual({
      kind: "local-stopped",
    });
  });

  it("stopped, then a Claude's tandem_reply naming the message (no agentIdentity): the row ends (review round 1, item 3)", () => {
    const m = user("u", 0, { localRun: run({ status: "stopped", reason: "error" }) });
    expect(chatPickup([m, claude("c", 1, { replyTo: "u" })], at, inputs())).toBeNull();
    // A superseded acknowledgement (#2358) answers nothing.
    expect(
      chatPickup(
        [m, claude("old", 1, { replyTo: "u", inProgress: true, superseded: true })],
        at,
        inputs(),
      ),
    ).toEqual({ kind: "local-stopped" });
  });

  it("no localRun and a notice row for it (A1's no-document / no-local-model): the row ends", () => {
    const m = user("u", 0);
    const notice = claude("n", 1, { replyTo: "u", chatNotice: "no-document" });
    expect(chatPickup([m, notice], at, inputs({ sentLocal: new Set(["u"]) }))).toBeNull();
  });

  it("no localRun, read or delivered: today's rows (a Claude has it), whatever the read says", () => {
    expect(
      chatPickup([user("u", 0, { read: true })], at, inputs({ sentLocal: new Set(["u"]) })),
    ).toEqual({
      kind: "received",
    });
    expect(chatPickup([user("u", 0, { delivered: true })], at, inputs())).toEqual({
      kind: "received",
    });
  });

  it("no localRun, sent by this window while known local, still known local, licence admits: 'Sent to your local model'", () => {
    const p = chatPickup([user("u", 0)], at, inputs({ sentLocal: new Set(["u"]) }));
    expect(p).toEqual({ kind: "local-sent" });
    expect(chatPickupLabel({ kind: "local-sent" })).toBe("Sent to your local model");
  });

  it("a message sent before the switch (not recorded as sent local): today's rows", () => {
    expect(chatPickup([user("u", 0)], at, inputs())).toEqual({ kind: "waiting", waitedMs: 5_000 });
  });

  it("under a licence refusal: never 'sent', today's rows", () => {
    expect(
      chatPickup([user("u", 0)], at, inputs({ sentLocal: new Set(["u"]), aiOff: true })),
    ).toEqual({
      kind: "waiting",
      waitedMs: 5_000,
    });
  });

  it("the read no longer known local: today's rows", () => {
    expect(
      chatPickup([user("u", 0)], at, inputs({ sentLocal: new Set(["u"]), readKnownLocal: false })),
    ).toEqual({ kind: "waiting", waitedMs: 5_000 });
  });

  it("the switch-back line after a message owed to Claude does not end its row (it names no message)", () => {
    const line = claude("line", 1, { chatNotice: "claude-again" });
    expect(chatPickup([user("u", 0), line], at, inputs())).toEqual({
      kind: "waiting",
      waitedMs: 5_000,
    });
    // While an untagged Claude row still ends it, as today.
    expect(chatPickup([user("u", 0), claude("c", 1)], at, inputs())).toBeNull();
  });

  it("a user row carrying chatNotice is not a notice", () => {
    const fake = { ...user("u", 0), chatNotice: "no-reply" } as ChatMessage;
    expect(chatPickup([fake], at, inputs({ sentLocal: new Set(["u"]) }))).toEqual({
      kind: "local-sent",
    });
  });

  it("every line expires with the age cap", () => {
    const m = user("u", 0, { localRun: run({ status: "stopped", reason: "error" }) });
    expect(chatPickup([m], T0 + PICKUP_MAX_AGE_MS + 1, inputs())).toBeNull();
  });

  it("no local inputs (the flag's wiring off): today's rows, localRun or not", () => {
    const m = user("u", 0, { localRun: run({ status: "running" }) });
    expect(chatPickup([m], at, null)).toEqual({ kind: "waiting", waitedMs: 5_000 });
  });
});

describe("visible and heard alike (R5.4)", () => {
  it("the announcement reads the same constant as the line, never the time", () => {
    for (const kind of [
      "local-interrupted",
      "local-working",
      "local-stopped",
      "local-sent",
    ] as const) {
      expect(chatPickupAnnouncement(kind)).toBe(chatPickupLabel({ kind }));
    }
  });

  it("no line says 'waiting for your AI' or names a model", () => {
    for (const kind of [
      "local-interrupted",
      "local-working",
      "local-stopped",
      "local-sent",
    ] as const) {
      const line = chatPickupLabel({ kind });
      expect(line).not.toMatch(/waiting for your AI/);
      expect(line).not.toMatch(/Claude/);
    }
  });
});
