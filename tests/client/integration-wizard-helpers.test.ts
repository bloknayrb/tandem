import { describe, expect, it } from "vitest";
import { computeDoneHeaderState } from "../../src/client/components/integration-wizard-helpers.js";

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
