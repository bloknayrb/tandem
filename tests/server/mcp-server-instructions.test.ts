import { describe, expect, it } from "vitest";

import { SERVER_INSTRUCTIONS } from "../../src/server/mcp/server.js";

/**
 * Prose constraints on the MCP `instructions` string.
 *
 * Lexical by necessity, and the precedent is `wake-advisory.test.ts`'s "what the text may never
 * contain" block: this string is a public interface delivered verbatim into every session's context,
 * with no executable implementation behind it. The constraints below each protect against a
 * regression that has either already happened once or is a documented failure mode.
 */
describe("MCP server instructions", () => {
  it("is populated at all — the whole mechanism is its presence at session start", () => {
    // Unset until 2026-08-11. Because only tool NAMES and server instructions load upfront when
    // tool search is on, an empty string meant nothing about wake monitoring was in context at the
    // moment a first-use session decided its behavior. PR #1393 measured that at 3/6 declines.
    expect(SERVER_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });

  it("fits inside the host's 2KB truncation, with the authority line first", () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")).toBeLessThan(2048);
    // Critical detail near the start, per Claude Code's own guidance: a truncated tail must not be
    // able to remove the one instruction that always applies.
    expect(SERVER_INSTRUCTIONS.indexOf("tandem_checkInbox")).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("wakeUrl"),
    );
  });

  it("carries no executable command", () => {
    // Same rule as the wake advisory: emitting a runnable command from Tandem teaches Claude that
    // Tandem's output legitimately carries commands, which an imported Word comment can imitate.
    // The command lives in SKILL.md, one place.
    expect(SERVER_INSTRUCTIONS).not.toContain("Monitor(");
    expect(SERVER_INSTRUCTIONS).not.toMatch(/```/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bnpx\b|\btandem setup\b/);
  });

  it("exempts the launcher-spawned population from arming", () => {
    // A launcher-spawned session is already woken on its stdin (#1266); a second watch double-wakes
    // every event. That caveat otherwise lives ONLY in SKILL.md's body, which is read second and
    // only if the skill is invoked at all — while these instructions arrive before any skill
    // decision. Without this clause, populating the field regresses the population that works.
    expect(SERVER_INSTRUCTIONS).toMatch(/if Tandem launched this session/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/double-wakes/i);
  });

  it("makes no per-session coverage claim and no count", () => {
    // The server cannot know whether THIS session is armed — the subscriber count is stale by
    // construction since #1354. "Nothing is subscribed" is the wake advisory's job, and only on the
    // one sound negative. This text is a standing instruction, not a diagnosis.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/nothing is (?:currently )?subscribed/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bnot covered\b|\bno one is watching\b/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\d+ (?:subscriber|consumer|pending)/i);
  });

  it("does not require a Claude-Code-specific capability by name", () => {
    // Reaches every MCP client, and a non-Claude client has no SKILL.md and no Monitor tool. Naming
    // one as a requirement would make the text wrong for that population rather than merely
    // inapplicable.
    expect(SERVER_INSTRUCTIONS).toMatch(/if your client can hold a persistent watch/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bskill\b/i);
  });

  it("bounds arming to once per session", () => {
    // A model re-reading an unbounded instruction late in a long session arms a second watch.
    expect(SERVER_INSTRUCTIONS).toMatch(/at most once/i);
  });

  it("states the Solo contract, which gates AI surfacing", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/solo/i);
  });
});
