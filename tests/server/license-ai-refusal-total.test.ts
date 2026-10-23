/**
 * `aiRefusal()` is total and fails closed (#1521). It runs unguarded inside
 * `pushEvent` and above every `/mcp` dispatch, so a throw from resolving the
 * licence state must become a refusal, never an exception or an admission.
 *
 * Armed via `TANDEM_LICENSE_GATE` before the import, as in
 * `license-armed-restricted.test.ts`: `GATE_ENABLED` is read once at import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

let throwOnResolve = false;
vi.mock("../../src/server/license/license-state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/license/license-state.js")>();
  return {
    ...real,
    resolveLiveLicenseState: () => {
      if (throwOnResolve) throw new RangeError("Invalid time value");
      return real.resolveLiveLicenseState();
    },
  };
});

import { aiRefusal } from "../../src/server/license/ai-refusal.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";
import {
  AI_REFUSAL_STATE_UNREADABLE_MESSAGE,
  aiRefusalUnverifiableMessage,
  LICENSE_REQUIRED,
} from "../../src/shared/license-copy.js";

afterEach(() => {
  throwOnResolve = false;
  vi.restoreAllMocks();
});

describe("aiRefusal() is total (#1521)", () => {
  it("runs armed", () => {
    expect(GATE_ENABLED).toBe(true);
  });

  it("a throw while resolving refuses as unverifiable, without the purchase URL", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnResolve = true;
    const refusal = aiRefusal();
    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe(LICENSE_REQUIRED);
    expect(refusal?.kind).toBe("unverifiable");
    expect(refusal?.message).not.toContain(TANDEM_PURCHASE_URL);
    // #2206: the throw says nothing about whether a licence exists, so the copy must not
    // claim one is installed (a keyless user with a corrupt trial.json lands here).
    expect(refusal?.message).toBe(AI_REFUSAL_STATE_UNREADABLE_MESSAGE);
    expect(refusal?.message).not.toMatch(/installed/i);
    expect(refusal?.message).not.toMatch(/\bunlicensed\b/i);
    expect(refusal?.message).not.toContain(aiRefusalUnverifiableMessage("UNKNOWN"));
    expect(err).toHaveBeenCalled();
  });
});
