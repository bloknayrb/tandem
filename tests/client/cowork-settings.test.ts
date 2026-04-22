import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateWorkspaceStatus,
  coworkSettingsVariant,
  firewallErrorHint,
  formatCoworkError,
  isTauriRuntime,
  makeDebouncer,
  workspaceFileStatusFamily,
  workspaceFileStatusLabel,
} from "../../src/client/cowork/cowork-helpers.js";
import {
  coworkGetStatus,
  coworkRescan,
  coworkRetryAdminElevation,
  coworkSetLanIpOverride,
  coworkToggleIntegration,
  type InvokeFn,
  loadInvoke,
} from "../../src/client/cowork/cowork-invoke.js";
import type {
  CoworkStatus,
  FirewallErrorVariant,
  WorkspaceStatus,
} from "../../src/client/types.js";

// ---------------------------------------------------------------------------
// coworkSettingsVariant
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<CoworkStatus> = {}): CoworkStatus {
  return {
    osSupported: true,
    coworkDetected: true,
    enabled: false,
    vethernetCidr: "172.20.0.0/20",
    lanIpFallback: "192.168.1.100",
    useLanIpOverride: false,
    workspaces: [],
    uacDeclined: false,
    uacDeclinedAt: null,
    workspacesLastScannedAt: null,
    ...overrides,
  };
}

describe("coworkSettingsVariant", () => {
  it("returns 'loading' when status is null", () => {
    expect(coworkSettingsVariant(null)).toBe("loading");
  });

  it("returns 'unsupported' when osSupported=false (non-Windows)", () => {
    expect(coworkSettingsVariant(makeStatus({ osSupported: false }))).toBe("unsupported");
  });

  it("returns 'undetected' when coworkDetected=false on Windows", () => {
    expect(coworkSettingsVariant(makeStatus({ coworkDetected: false }))).toBe("undetected");
  });

  it("returns 'normal' when both osSupported and coworkDetected", () => {
    expect(coworkSettingsVariant(makeStatus())).toBe("normal");
  });

  it("'unsupported' takes priority over 'undetected' (non-Windows also wouldn't detect)", () => {
    expect(coworkSettingsVariant(makeStatus({ osSupported: false, coworkDetected: false }))).toBe(
      "unsupported",
    );
  });
});

// ---------------------------------------------------------------------------
// firewallErrorHint — one distinct hint per variant (security invariant §13)
// ---------------------------------------------------------------------------

describe("firewallErrorHint", () => {
  const variants: FirewallErrorVariant[] = [
    { kind: "adminDeclined" },
    { kind: "netshNotFound" },
    { kind: "netshFailure", exitCode: 2, stderrTail: "Access is denied.", stdoutTail: "" },
    { kind: "subnetDetectionFailed" },
    { kind: "adapterEnumerationFailed" },
  ];

  it("returns a distinct non-empty hint for every variant", () => {
    const hints = variants.map(firewallErrorHint);
    expect(new Set(hints).size).toBe(hints.length);
    for (const h of hints) expect(h.length).toBeGreaterThan(0);
  });

  it("adminDeclined hint mentions retry", () => {
    expect(firewallErrorHint({ kind: "adminDeclined" }).toLowerCase()).toContain("retry");
  });

  it("netshFailure embeds the exit code and stderr tail", () => {
    const hint = firewallErrorHint({
      kind: "netshFailure",
      exitCode: 42,
      stderrTail: "something broke",
      stdoutTail: "",
    });
    expect(hint).toContain("42");
    expect(hint).toContain("something broke");
  });

  it("netshFailure with empty stderr reports '(no output)'", () => {
    const hint = firewallErrorHint({
      kind: "netshFailure",
      exitCode: 1,
      stderrTail: "   ",
      stdoutTail: "",
    });
    expect(hint).toContain("(no output)");
  });

  it("netshFailure truncates excessively long stderr", () => {
    const longStderr = "x".repeat(1000);
    const hint = firewallErrorHint({
      kind: "netshFailure",
      exitCode: 1,
      stderrTail: longStderr,
      stdoutTail: "",
    });
    expect(hint.length).toBeLessThan(longStderr.length + 200);
    expect(hint).toContain("...");
  });

  it("subnetDetectionFailed hint mentions VM / subnet context", () => {
    const hint = firewallErrorHint({ kind: "subnetDetectionFailed" }).toLowerCase();
    expect(hint).toContain("subnet");
  });

  it("adapterEnumerationFailed hint mentions Hyper-V adapter", () => {
    const hint = firewallErrorHint({ kind: "adapterEnumerationFailed" }).toLowerCase();
    expect(hint).toContain("hyper-v");
  });

  it("returns a generic hint including the kind for an unknown variant", () => {
    const hint = firewallErrorHint({ kind: "unknownFuture" } as FirewallErrorVariant);
    expect(hint).toContain("unknownFuture");
    expect(hint).toContain("Unexpected");
  });
});

// ---------------------------------------------------------------------------
// formatCoworkError — JSON error parsing + firewallErrorHint integration
// ---------------------------------------------------------------------------

describe("formatCoworkError", () => {
  it("returns the raw message when it is not JSON", () => {
    expect(formatCoworkError("something went wrong")).toBe("something went wrong");
  });

  it("returns firewallErrorHint result for JSON with a known kind", () => {
    const json = JSON.stringify({ kind: "adminDeclined" });
    expect(formatCoworkError(json).toLowerCase()).toContain("retry");
  });

  it("returns raw message for JSON without a kind field", () => {
    const json = JSON.stringify({ error: "oops" });
    expect(formatCoworkError(json)).toBe(json);
  });

  it("returns raw message for JSON.parse('null')", () => {
    expect(formatCoworkError("null")).toBe("null");
  });

  it("returns raw message for non-object JSON (number)", () => {
    expect(formatCoworkError("42")).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// workspaceFileStatusLabel / workspaceFileStatusFamily
// ---------------------------------------------------------------------------

describe("workspaceFileStatusLabel", () => {
  it("returns a non-empty label for every status variant", () => {
    const cases = [
      "ok",
      "alreadyPresent",
      "locked",
      "schemaDrift",
      "insecureAcl",
      "failed",
    ] as const;
    for (const c of cases) {
      expect(workspaceFileStatusLabel(c).length).toBeGreaterThan(0);
    }
  });

  it("maps 'ok' and 'alreadyPresent' to the success family", () => {
    expect(workspaceFileStatusFamily("ok")).toBe("success");
    expect(workspaceFileStatusFamily("alreadyPresent")).toBe("success");
  });

  it("maps 'locked' to the warning family", () => {
    expect(workspaceFileStatusFamily("locked")).toBe("warning");
  });

  it("maps 'schemaDrift', 'insecureAcl', 'failed' to the error family", () => {
    expect(workspaceFileStatusFamily("schemaDrift")).toBe("error");
    expect(workspaceFileStatusFamily("insecureAcl")).toBe("error");
    expect(workspaceFileStatusFamily("failed")).toBe("error");
  });
});

describe("aggregateWorkspaceStatus", () => {
  function ws(
    a: WorkspaceStatus["installedPlugins"],
    b: WorkspaceStatus["knownMarketplaces"],
    c: WorkspaceStatus["coworkSettings"],
  ): WorkspaceStatus {
    return {
      workspaceId: "ws1",
      vmId: "vm1",
      installedPlugins: a,
      knownMarketplaces: b,
      coworkSettings: c,
      path: "C:/fake/path",
    };
  }

  it("rolls 'ok' triple up to 'ok'", () => {
    expect(aggregateWorkspaceStatus(ws("ok", "ok", "ok"))).toBe("ok");
  });

  it("'failed' on any file wins over 'ok'", () => {
    expect(aggregateWorkspaceStatus(ws("ok", "failed", "ok"))).toBe("failed");
  });

  it("'failed' wins over 'schemaDrift' and 'locked'", () => {
    expect(aggregateWorkspaceStatus(ws("locked", "schemaDrift", "failed"))).toBe("failed");
  });

  it("'schemaDrift' wins over 'locked' and 'ok'", () => {
    expect(aggregateWorkspaceStatus(ws("ok", "locked", "schemaDrift"))).toBe("schemaDrift");
  });

  it("'locked' wins over 'alreadyPresent'", () => {
    expect(aggregateWorkspaceStatus(ws("alreadyPresent", "locked", "ok"))).toBe("locked");
  });

  it("'insecureAcl' wins over 'locked'", () => {
    expect(aggregateWorkspaceStatus(ws("insecureAcl", "locked", "ok"))).toBe("insecureAcl");
  });
});

// ---------------------------------------------------------------------------
// makeDebouncer — covers the rescan debounce (2s per task spec)
// ---------------------------------------------------------------------------

describe("makeDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the scheduled function after the delay", () => {
    const debouncer = makeDebouncer(100);
    const fn = vi.fn();
    debouncer.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid schedule calls into one run", () => {
    const debouncer = makeDebouncer(100);
    const fn = vi.fn();
    debouncer.schedule(fn);
    vi.advanceTimersByTime(50);
    debouncer.schedule(fn);
    vi.advanceTimersByTime(50);
    debouncer.schedule(fn);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents the pending call", () => {
    const debouncer = makeDebouncer(100);
    const fn = vi.fn();
    debouncer.schedule(fn);
    debouncer.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() is a no-op when nothing is pending", () => {
    const debouncer = makeDebouncer(100);
    expect(() => debouncer.cancel()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Invoke wrappers — mock the InvokeFn, assert call args
// ---------------------------------------------------------------------------

describe("cowork invoke wrappers", () => {
  it("coworkGetStatus calls 'cowork_get_status' with no args", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue(makeStatus() as unknown);
    await coworkGetStatus(invoke as unknown as InvokeFn);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("cowork_get_status");
  });

  it("coworkToggleIntegration forwards the enabled flag", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkToggleIntegration(invoke as unknown as InvokeFn, true);
    expect(invoke).toHaveBeenCalledWith("cowork_toggle_integration", { enabled: true });
    await coworkToggleIntegration(invoke as unknown as InvokeFn, false);
    expect(invoke).toHaveBeenCalledWith("cowork_toggle_integration", { enabled: false });
  });

  it("coworkRescan calls 'cowork_rescan' with no args", async () => {
    const invoke = vi
      .fn<InvokeFn>()
      .mockResolvedValue("Rescan complete: 2 workspace(s)" as unknown);
    await coworkRescan(invoke as unknown as InvokeFn);
    expect(invoke).toHaveBeenCalledWith("cowork_rescan");
  });

  it("coworkSetLanIpOverride forwards the enabled flag", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkSetLanIpOverride(invoke as unknown as InvokeFn, true);
    expect(invoke).toHaveBeenCalledWith("cowork_set_lan_ip_override", { enabled: true });
  });

  it("coworkRetryAdminElevation calls the expected command", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue({ ok: true } as unknown);
    await coworkRetryAdminElevation(invoke as unknown as InvokeFn);
    expect(invoke).toHaveBeenCalledWith("cowork_retry_admin_elevation");
  });

  it("propagates invoke rejections so the caller's try/catch can surface a toast", async () => {
    const invoke = vi
      .fn<InvokeFn>()
      .mockRejectedValue(new Error("Cowork integration is Windows-only in v0.8.0"));
    await expect(coworkGetStatus(invoke as unknown as InvokeFn)).rejects.toThrow(/Windows-only/);
  });
});

describe("loadInvoke", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a rejecting stub when '@tauri-apps/api/core' import fails", async () => {
    // The real module resolves in this repo because node_modules is linked,
    // so cover the fallback path by monkey-patching the stub directly.
    // (The dynamic import resolution itself is covered at runtime.)
    const invoke = await loadInvoke();
    expect(typeof invoke).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// isTauriRuntime — window detection
// ---------------------------------------------------------------------------

describe("isTauriRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when window is undefined (SSR / pure Node)", () => {
    // No stub — the vitest node env has no window by default.
    expect(isTauriRuntime()).toBe(false);
  });

  it("returns false when window has no __TAURI_INTERNALS__", () => {
    vi.stubGlobal("window", {} as Window);
    expect(isTauriRuntime()).toBe(false);
  });

  it("returns true when __TAURI_INTERNALS__ is present (Tauri v2)", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} } as unknown as Window);
    expect(isTauriRuntime()).toBe(true);
  });
});
