import { describe, expect, it } from "vitest";
import {
  computeDoneHeaderState,
  pushSupportNote,
  tandemClaudeDoneCopy,
  tandemClaudeIsStartingOrRunning,
  tandemClaudeNeedsSignIn,
} from "../../src/client/components/integration-wizard-helpers.js";
import { targetPushSupport } from "../../src/shared/integrations/contract.js";
import { TANDEM_CLAUDE_AFTER_SETUP } from "../../src/shared/launcher/contract.js";

describe("computeDoneHeaderState", () => {
  it("is 'connected' only when Claude has actually connected", () => {
    expect(computeDoneHeaderState(false, true)).toBe("connected");
  });

  it("is 'waiting' when the config wrote cleanly but Claude has not connected yet", () => {
    // The load-bearing WS-B state: a successful write is NOT a connection, so
    // the header must not show a green check until claudeConnected is true.
    expect(computeDoneHeaderState(false, false)).toBe("waiting");
  });

  it("is 'partial' when any apply item errored", () => {
    expect(computeDoneHeaderState(true, false)).toBe("partial");
  });

  it("lets an apply error win even if a stale reachability probe reads connected", () => {
    // Errors take precedence: a broken write can't have produced a real
    // connection, so 'partial' must beat a lingering 'connected' reading.
    expect(computeDoneHeaderState(true, true)).toBe("partial");
  });
});

describe("pushSupportNote (#1299)", () => {
  it("speaks up for a client nothing can notify", () => {
    // The whole point: Claude Desktop gets no channel shim, no supervisor
    // wake, no plugin monitor — push does not fail there, it does not exist —
    // and until now the wizard knew that and said nothing.
    const note = pushSupportNote("claude-desktop");
    expect(note).not.toBeNull();
    expect(note?.text).toMatch(/can't notify this one in real time/i);
    // Deferred, never lost — and deferred to an action the AI takes, not one
    // the USER takes. "the next time you prompt it" reads as a delivery
    // guarantee for the next turn; Claude only sees a comment when it calls
    // `tandem_checkInbox`, which a given turn may simply not do. Asserted both
    // ways because the wrong phrasing also matches "next time" loosely.
    expect(note?.text).toMatch(/the next time it checks in/i);
    expect(note?.text).not.toMatch(/prompt it/i);
    // "this app" is ambiguous read inside Tandem's own wizard — it parses at
    // least as readily as Tandem, which is the opposite of the intended claim.
    expect(note?.text).not.toMatch(/this app/i);
  });

  it("stays silent when a transport merely EXISTS", () => {
    // `"possible"` is not a guarantee — the channel shim registers by default
    // for Claude Code and then discards every notification if the host never
    // negotiated `claude/channel` (findings A5/A7). An affirmative line here
    // would be the exact false promise the negative one exists to avoid.
    expect(pushSupportNote("claude-code")).toBeNull();
  });

  it.each([
    { kind: "other-mcp" as const, why: "a kind the wizard cannot reason about" },
    { kind: undefined, why: "a row whose picked entry has gone" },
  ])("stays silent for $why", ({ kind }) => {
    // Absence of knowledge is not a negative — the same asymmetry
    // `PushDelivery`'s `"unknown"` encodes.
    expect(pushSupportNote(kind)).toBeNull();
  });

  it("renders exactly when the shared predicate says 'none'", () => {
    // Pins the note to the predicate rather than to a hard-coded kind list, so
    // a future kind joining `"none"` cannot get a silent row.
    //
    // NOTE this loop can only ever cover the kinds it names, so it cannot by
    // itself prove the helper is kind-agnostic — a kind omitted from an
    // allow-list inside the helper would also be omitted here and the test
    // would stay green. The guard is written as an EXCLUSION of `"other-mcp"`
    // for that reason; nothing here enforces it, only the type does
    // (`IntegrationConfig["kind"]` minus `"other-mcp"` is exactly
    // `DetectedTarget["kind"]`, which is what `targetPushSupport` accepts).
    for (const kind of ["claude-code", "claude-desktop"] as const) {
      expect(pushSupportNote(kind) !== null).toBe(targetPushSupport(kind) === "none");
    }
  });
});

describe("tandemClaudeDoneCopy (#2197)", () => {
  const stopped = { running: false, remedy: null, standby: null } as const;

  it("says nothing without an answer to report", () => {
    expect(tandemClaudeDoneCopy(null, null)).toBeNull();
    expect(tandemClaudeDoneCopy("unknown", stopped)).toBeNull();
  });

  it("tandemClaudeIsStartingOrRunning holds exactly when the line is the starting or running one", () => {
    const answers = [null, ...TANDEM_CLAUDE_AFTER_SETUP] as const;
    const remedies = [null, "connect", "setup", "sign-in", "restart", "start", "ai-off"] as const;
    const standbys = [null, "off", "idle", "awaiting-start"] as const;
    const lives = [
      null,
      { running: true, remedy: null, standby: null },
      ...remedies.flatMap((remedy) =>
        standbys.map((standby) => ({ running: false, remedy, standby })),
      ),
    ] as const;
    for (const a of answers) {
      for (const l of lives) {
        const line = tandemClaudeDoneCopy(a, l) ?? "";
        const startingOrRunning =
          line.startsWith("Tandem is starting its own Claude") ||
          line.startsWith("Tandem's own Claude is running");
        expect(tandemClaudeIsStartingOrRunning(a, l), `${a} ${JSON.stringify(l)}`).toBe(
          startingOrRunning,
        );
      }
    }
  });

  it("an answer that timed out is overruled by a Claude that is running now", () => {
    expect(tandemClaudeDoneCopy("unknown", { ...stopped, running: true })).toMatch(
      /^Tandem's own Claude is running/,
    );
  });

  it("starting, then running: names Tandem's own Claude and where it talks", () => {
    expect(tandemClaudeDoneCopy("starting", stopped)).toMatch(/^Tandem is starting its own Claude/);
    expect(tandemClaudeDoneCopy("starting", { ...stopped, running: true })).toMatch(
      /^Tandem's own Claude is running/,
    );
  });

  it("a start that has since failed stops promising one", () => {
    const line = tandemClaudeDoneCopy("starting", { ...stopped, remedy: "restart" });
    expect(line).toMatch(/couldn't start/);
    expect(line).not.toMatch(/starting/);
  });

  it("a sign-in stop is the sign-in step, whatever the Apply answered (#2199)", () => {
    for (const initial of ["starting", "running", "held", "other-ai", "cli-unusable"] as const) {
      expect(tandemClaudeDoneCopy(initial, { ...stopped, remedy: "sign-in" })).toMatch(
        /^One more step: sign in to Claude Code/,
      );
      // The line and the Check sign-in button share one predicate.
      expect(tandemClaudeNeedsSignIn(initial, { ...stopped, remedy: "sign-in" })).toBe(true);
    }
    expect(tandemClaudeNeedsSignIn(null, { ...stopped, remedy: "sign-in" })).toBe(false);
    expect(tandemClaudeNeedsSignIn("starting", { ...stopped, remedy: "restart" })).toBe(false);
    // Running wins over it: a sign-in that has since worked is not still owed.
    expect(
      tandemClaudeDoneCopy("starting", { ...stopped, running: true, remedy: "sign-in" }),
    ).toMatch(/^Tandem's own Claude is running/);
  });

  it.each([
    ["off", "turned off"],
    ["idle", "chat message starts it"],
    ["awaiting-start", "click Start"],
  ] as const)("held, standby %s", (standby, phrase) => {
    expect(tandemClaudeDoneCopy("held", { ...stopped, standby })).toContain(phrase);
  });

  it("a start that has since settled into a standby says so, not 'starting'", () => {
    const line = tandemClaudeDoneCopy("starting", { ...stopped, standby: "idle", remedy: "start" });
    expect(line).toMatch(/stopped while it was idle/);
  });

  it("whatever the Apply answered, a Claude running now reads as running", () => {
    for (const initial of ["held", "other-ai"] as const) {
      expect(tandemClaudeDoneCopy(initial, { ...stopped, running: true })).toMatch(
        /^Tandem's own Claude is running/,
      );
    }
  });

  it("held over a diagnosis points at it, not at Start", () => {
    const line = tandemClaudeDoneCopy("held", { ...stopped, remedy: "restart" });
    expect(line).toMatch(/is stopped/);
    expect(line).not.toMatch(/click Start/);
  });

  it.each([
    ["other-ai", "another AI session"],
    ["refused", "Settings → License"],
    ["not-configured", "couldn't find the Claude Code setup it just saved"],
    ["cli-unusable", "couldn't find Claude Code on this computer"],
  ] as const)("%s has its own line", (initial, phrase) => {
    expect(tandemClaudeDoneCopy(initial, stopped)).toContain(phrase);
  });

  it("never claims a hello on a re-run: 'on a first run' qualifies it", () => {
    for (const live of [stopped, { ...stopped, running: true }]) {
      const line = tandemClaudeDoneCopy("starting", live) ?? "";
      if (line.includes("hello")) expect(line).toContain("on a first run");
    }
  });
});
