/**
 * The chat panel's resume row (#2196): what it says about a message sent while
 * Tandem's Claude was stopped by choice. Its rule is to never promise an answer
 * nothing is coming to give, so every arm that is not "a start is visibly
 * under way" has a bound.
 */
import { describe, expect, it } from "vitest";
import {
  type ChatResumeInput,
  chatResume,
  chatResumeLabel,
  RESUME_GRACE_MS,
} from "../../src/client/panels/chat-resume";

const AT = 1_000_000;
const base: ChatResumeInput = {
  running: false,
  serverUnreachable: false,
  restarting: false,
  standby: "off",
  remedy: "start",
  now: AT,
};

describe("chatResume", () => {
  it("no request, no row", () => {
    expect(chatResume(null, base)).toBeNull();
  });

  it("steps aside once Claude runs — the pickup row takes over", () => {
    expect(chatResume({ at: AT, from: "idle" }, { ...base, running: true })).toBeNull();
  });

  it("an idle-stopped Claude is resuming; one that was off or never started is starting", () => {
    expect(chatResume({ at: AT, from: "idle" }, base)).toEqual({
      kind: "resuming",
      verb: "resuming",
    });
    expect(chatResume({ at: AT, from: "off" }, base)).toEqual({
      kind: "resuming",
      verb: "starting",
    });
    expect(chatResume({ at: AT, from: "awaiting-start" }, base)).toEqual({
      kind: "resuming",
      verb: "starting",
    });
  });

  it("a start under way is resuming however long it takes", () => {
    expect(
      chatResume(
        { at: AT, from: "off" },
        { ...base, restarting: true, remedy: null, now: AT + 10 * RESUME_GRACE_MS },
      ),
    ).toEqual({ kind: "resuming", verb: "starting" });
  });

  it("still in standby past the grace: the start never began, so it says so and offers Start", () => {
    expect(
      chatResume({ at: AT, from: "idle" }, { ...base, now: AT + RESUME_GRACE_MS - 1 }),
    ).toMatchObject({ kind: "resuming" });
    expect(chatResume({ at: AT, from: "idle" }, { ...base, now: AT + RESUME_GRACE_MS })).toEqual({
      kind: "failed",
      remedy: "start",
    });
  });

  it.each(["restart", "setup", "sign-in", "connect"] as const)(
    "a start that ended in a failure offers that failure's own remedy (%s)",
    (remedy) => {
      expect(chatResume({ at: AT, from: "off" }, { ...base, standby: null, remedy })).toEqual({
        kind: "failed",
        remedy,
      });
    },
  );

  it("the licence refusing the AI: never 'starting', and never a Start the server would refuse", () => {
    // The standby still reads as it did; the licence lapsed since the send.
    expect(
      chatResume({ at: AT, from: "off" }, { ...base, standby: "off", remedy: "ai-off" }),
    ).toEqual({ kind: "failed", remedy: "ai-off" });
    expect(
      chatResume(
        { at: AT, from: "idle" },
        { ...base, standby: "idle", remedy: "ai-off", now: AT + RESUME_GRACE_MS },
      ),
    ).toEqual({ kind: "failed", remedy: "ai-off" });
  });

  it("a start whose status read failed (raw restartPending, fresh gate down) is still resuming", () => {
    // standby kept, remedy null because the raw status still says restartPending.
    expect(
      chatResume(
        { at: AT, from: "off" },
        { ...base, restarting: false, remedy: null, now: AT + RESUME_GRACE_MS * 3 },
      ),
    ).toMatchObject({ kind: "resuming" });
  });

  it("says nothing while the server is unreachable — the offline notice speaks for it", () => {
    expect(chatResume({ at: AT, from: "off" }, { ...base, serverUnreachable: true })).toBeNull();
    expect(
      chatResume(
        { at: AT, from: "off" },
        { ...base, serverUnreachable: true, now: AT + RESUME_GRACE_MS },
      ),
    ).toBeNull();
  });

  it("an unknown status earns the grace and then silence, never a claim", () => {
    const unknown = { ...base, standby: null, remedy: null };
    expect(chatResume({ at: AT, from: "off" }, unknown)).toMatchObject({ kind: "resuming" });
    expect(
      chatResume({ at: AT, from: "off" }, { ...unknown, now: AT + RESUME_GRACE_MS }),
    ).toBeNull();
  });
});

describe("chatResumeLabel", () => {
  it("says resuming, starting, or that the message has not been answered", () => {
    expect(chatResumeLabel({ kind: "resuming", verb: "resuming" })).toMatch(/^Claude is resuming…/);
    expect(chatResumeLabel({ kind: "resuming", verb: "starting" })).toMatch(
      /^Starting Tandem's Claude…/,
    );
    expect(chatResumeLabel({ kind: "failed", remedy: "start" })).toContain("hasn't been answered");
  });
});
