import { describe, expect, it } from "vitest";
import { type GreetingNoteInputs, greetingNoteAction } from "../../src/client/panels/chat-greeting";

/** Late, running, nothing in the way: the note offers a restart. */
const base: GreetingNoteInputs = {
  greetingLate: true,
  serverUnreachable: false,
  aiOff: false,
  stoppedByChoice: false,
  busy: false,
  running: true,
  remedy: null,
};

describe("greetingNoteAction (#2197)", () => {
  it("no note unless the server says the hello is late", () => {
    expect(greetingNoteAction({ ...base, greetingLate: false })).toBeNull();
  });

  it("running: restart; stopped: the launcher's own remedy", () => {
    expect(greetingNoteAction(base)).toBe("relaunch");
    expect(greetingNoteAction({ ...base, running: false, remedy: "sign-in" })).toBe("sign-in");
  });

  // Each gate names a state where the note would mislead, or its button harm.
  it.each([
    ["the server is unreachable", { serverUnreachable: true }],
    ["the licence refuses the AI", { aiOff: true }],
    ["it is stopped by choice", { stoppedByChoice: true, running: false, remedy: "start" }],
    ["it is mid-turn (a slow hello, which Restart would kill)", { busy: true }],
    ["stopped with no remedy: a restart is already under way", { running: false, remedy: null }],
  ] as const)("no note while %s", (_l, patch) => {
    expect(greetingNoteAction({ ...base, ...patch })).toBeNull();
  });
});
