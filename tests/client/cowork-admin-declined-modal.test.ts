import { describe, expect, it, vi } from "vitest";
import {
  coworkRetryAdminElevation,
  coworkToggleIntegration,
  type InvokeFn,
} from "../../src/client/cowork/cowork-invoke.js";
import type { CoworkStatus } from "../../src/client/types.js";

// ---------------------------------------------------------------------------
// Modal visibility condition
//
// CoworkAdminDeclinedModal renders when status.uacDeclined === true and
// returns null otherwise. Tests here verify the condition logic without
// mounting the component (consistent with the project's pure-function test
// pattern).
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<CoworkStatus> = {}): CoworkStatus {
  return {
    osSupported: true,
    coworkDetected: true,
    enabled: true,
    vethernetCidr: "172.20.0.0/20",
    lanIpFallback: null,
    useLanIpOverride: false,
    workspaces: [],
    uacDeclined: false,
    uacDeclinedAt: null,
    workspacesLastScannedAt: null,
    ...overrides,
  };
}

/** Pure predicate mirroring `CoworkAdminDeclinedModal`'s visibility guard. */
function shouldShowModal(status: CoworkStatus | null): boolean {
  return status?.uacDeclined === true;
}

describe("CoworkAdminDeclinedModal visibility condition", () => {
  it("is hidden when status is null (loading)", () => {
    expect(shouldShowModal(null)).toBe(false);
  });

  it("is hidden when uacDeclined is false (normal state)", () => {
    expect(shouldShowModal(makeStatus({ uacDeclined: false }))).toBe(false);
  });

  it("is shown when uacDeclined is true (elevation refused)", () => {
    expect(shouldShowModal(makeStatus({ uacDeclined: true }))).toBe(true);
  });

  it("is shown even when Cowork is disabled — fail-closed means modal stays until resolved", () => {
    expect(shouldShowModal(makeStatus({ uacDeclined: true, enabled: false }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry action — coworkRetryAdminElevation
//
// The modal's "Retry with admin" button calls coworkRetryAdminElevation.
// Verify the command name and that a failure propagates so the component
// can surface the error string in its error <div>.
// ---------------------------------------------------------------------------

describe("CoworkAdminDeclinedModal retry action", () => {
  it("calls cowork_retry_admin_elevation with no extra args", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkRetryAdminElevation(invoke as unknown as InvokeFn);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("cowork_retry_admin_elevation");
  });

  it("propagates rejection so the modal can display an error banner", async () => {
    const invoke = vi.fn<InvokeFn>().mockRejectedValue(new Error("UAC timed out"));
    await expect(coworkRetryAdminElevation(invoke as unknown as InvokeFn)).rejects.toThrow(
      "UAC timed out",
    );
  });
});

// ---------------------------------------------------------------------------
// Disable action — coworkToggleIntegration(invoke, false)
//
// The modal's "Disable Cowork" confirmation path calls toggle with false.
// Verifies the correct command and argument shape.
// ---------------------------------------------------------------------------

describe("CoworkAdminDeclinedModal disable action", () => {
  it("calls cowork_toggle_integration with enabled:false", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkToggleIntegration(invoke as unknown as InvokeFn, false);
    expect(invoke).toHaveBeenCalledWith("cowork_toggle_integration", { enabled: false });
  });

  it("does NOT accidentally call with enabled:true", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkToggleIntegration(invoke as unknown as InvokeFn, false);
    expect(invoke).not.toHaveBeenCalledWith("cowork_toggle_integration", { enabled: true });
  });

  it("propagates rejection so the modal can display an error banner", async () => {
    const invoke = vi
      .fn<InvokeFn>()
      .mockRejectedValue(new Error("cowork_toggle_integration failed"));
    await expect(coworkToggleIntegration(invoke as unknown as InvokeFn, false)).rejects.toThrow(
      "cowork_toggle_integration failed",
    );
  });
});
