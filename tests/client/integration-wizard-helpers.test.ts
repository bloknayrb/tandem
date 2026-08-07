import { describe, expect, it } from "vitest";
import {
  computeDoneHeaderState,
  pushSupportNote,
} from "../../src/client/components/integration-wizard-helpers.js";
import { targetPushSupport } from "../../src/shared/integrations/contract.js";

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
