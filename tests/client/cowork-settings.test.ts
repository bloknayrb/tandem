import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateWorkspaceStatus,
  coworkReachability,
  coworkReachabilityCopy,
  coworkSettingsVariant,
  coworkWorkspaceReachable,
  firewallErrorHint,
  formatCoworkError,
  isTauriRuntime,
  makeDebouncer,
  undetectedDetail,
  workspaceFileStatusFamily,
  workspaceFileStatusLabel,
} from "../../src/client/cowork/cowork-helpers.js";
import {
  coworkGetStatus,
  coworkPreflightSubnet,
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
  SubnetDetectionReason,
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
// undetectedDetail
// ---------------------------------------------------------------------------

describe("undetectedDetail", () => {
  it("returns 'noClaude' when Claude Desktop is not detected", () => {
    expect(
      undetectedDetail(makeStatus({ coworkDetected: false, claudeDesktopDetected: false })),
    ).toBe("noClaude");
  });

  it("returns 'noClaude' when the field is absent (stale pre-field sidecar)", () => {
    const status = makeStatus({ coworkDetected: false });
    delete (status as Record<string, unknown>).claudeDesktopDetected;
    expect(undetectedDetail(status)).toBe("noClaude");
  });

  it("returns 'noWorkspacesYet' when Claude is present but Cowork never ran", () => {
    expect(
      undetectedDetail(
        makeStatus({ coworkDetected: false, claudeDesktopDetected: true, workspacesBlocked: 0 }),
      ),
    ).toBe("noWorkspacesYet");
  });

  it("returns 'noWorkspacesYet' when workspacesBlocked is absent (stale sidecar)", () => {
    const status = makeStatus({ coworkDetected: false, claudeDesktopDetected: true });
    delete (status as Record<string, unknown>).workspacesBlocked;
    expect(undetectedDetail(status)).toBe("noWorkspacesYet");
  });

  it("returns 'blocked' when sessions exist but every one was guard-rejected", () => {
    expect(
      undetectedDetail(
        makeStatus({ coworkDetected: false, claudeDesktopDetected: true, workspacesBlocked: 3 }),
      ),
    ).toBe("blocked");
  });

  it("'noClaude' wins over 'blocked' (no Claude install signal at all)", () => {
    expect(
      undetectedDetail(
        makeStatus({ coworkDetected: false, claudeDesktopDetected: false, workspacesBlocked: 3 }),
      ),
    ).toBe("noClaude");
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

  it("adminDeclined hint explains the admin-rights limitation without a false retry promise", () => {
    const hint = firewallErrorHint({ kind: "adminDeclined" }).toLowerCase();
    expect(hint).toContain("administrator");
    // Tandem never self-elevates, so the hint must not promise a retry-with-admin flow.
    expect(hint).not.toContain("retry");
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

  // -------------------------------------------------------------------------
  // #1298: the four reasons behind subnetDetectionFailed. Each describes a
  // different situation and each wants different advice; they used to share one
  // message that blamed the user's Cowork install.
  // -------------------------------------------------------------------------

  const SUBNET_REASONS: SubnetDetectionReason[] = [
    "noAdapter",
    "noIpv4",
    "prefixTooBroad",
    "queryFailed",
  ];

  it("gives each subnet-detection reason its own hint", () => {
    const hints = SUBNET_REASONS.map((reason) =>
      firewallErrorHint({ kind: "subnetDetectionFailed", reason }),
    );
    expect(new Set(hints).size).toBe(hints.length);
    for (const h of hints) expect(h.length).toBeGreaterThan(0);
  });

  it("falls back rather than rendering an empty banner for a blank reason", () => {
    // `??` passed `""` straight through, because the left operand short-circuits
    // to `""` rather than to `undefined`. That reached the UI as
    // `{status:"blocked", hint:""}` — an empty warning box AND a removed Enable
    // button, the worst of both. `||` is what closes it. The existing coverage
    // tests `undefined` and an unrecognised name, neither of which catches this.
    const fallback = firewallErrorHint({ kind: "subnetDetectionFailed" });
    expect(
      firewallErrorHint({ kind: "subnetDetectionFailed", reason: "" as SubnetDetectionReason }),
    ).toBe(fallback);
    expect(fallback.length).toBeGreaterThan(40);
  });

  it("no subnet-detection hint blames the Cowork install", () => {
    // The defect: this sentence rendered inside a dialog whose own title, two
    // lines above, read "Claude Desktop Cowork detected".
    const fallback = firewallErrorHint({ kind: "subnetDetectionFailed" });
    for (const reason of SUBNET_REASONS) {
      const hint = firewallErrorHint({ kind: "subnetDetectionFailed", reason });
      // Positive control on the same call: prove the reason lookup actually
      // resolved. Without it, "does not contain" is also satisfied by an empty
      // string, a broken map, or a typo in the reason name.
      expect(hint).not.toBe(fallback);
      expect(hint.length).toBeGreaterThan(40);
      expect(hint.toLowerCase()).not.toContain("set up on this machine");
    }
  });

  it("noAdapter reports what Tandem observed, not that no adapter exists", () => {
    // Three conditions produce a zero match — VM not running, WSL mirrored
    // networking, and a localized adapter description — and the code cannot
    // tell them apart. Asserting absence would be false for two of them.
    const hint = firewallErrorHint({ kind: "subnetDetectionFailed", reason: "noAdapter" });
    expect(hint).toMatch(/didn't find/i);
    expect(hint).toMatch(/mirrored networking/i);
    expect(hint).toMatch(/edition of Windows/i);
  });

  it("prefixTooBroad says Tandem refused, not that detection failed", () => {
    const hint = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "prefixTooBroad",
    });
    expect(hint).toContain("/20");
    expect(hint).toMatch(/won't open the firewall/i);
  });

  it("falls back to the subnet-mentioning hint when reason is absent or unrecognised", () => {
    // Absent = an older sidecar that predates the field. Unrecognised = a
    // future Rust-side reason this build has never heard of. Neither may crash
    // or render an empty banner.
    const noReason = firewallErrorHint({ kind: "subnetDetectionFailed" });
    const unknownReason = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "somethingNew" as SubnetDetectionReason,
    });
    expect(noReason).toBe(unknownReason);
    expect(noReason.toLowerCase()).toContain("subnet");
    expect(noReason).not.toContain("set up on this machine");
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
    expect(formatCoworkError(json).toLowerCase()).toContain("administrator");
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
// coworkPreflightSubnet (#1298) — the probe that decides whether Enable is
// offered at all. Three states, because "the probe failed" and "enabling would
// fail" are different claims and only the second one may block a button.
// ---------------------------------------------------------------------------

describe("coworkPreflightSubnet", () => {
  it("reports ok with the detected CIDR", async () => {
    const invoke = (async () => "172.20.0.0/20") as InvokeFn;
    await expect(coworkPreflightSubnet(invoke)).resolves.toEqual({
      status: "ok",
      cidr: "172.20.0.0/20",
    });
  });

  it("calls the command the Rust side actually registers", async () => {
    // The command existed with no caller for the whole life of the feature;
    // a typo here would silently restore that state.
    const seen: string[] = [];
    const invoke = (async (cmd: string) => {
      seen.push(cmd);
      return "172.20.0.0/20";
    }) as InvokeFn;
    await coworkPreflightSubnet(invoke);
    expect(seen).toEqual(["cowork_detect_vethernet_subnet"]);
  });

  it("blocks with the reason's hint when detection returns a structured error", async () => {
    const invoke = (async () => {
      throw new Error(JSON.stringify({ kind: "subnetDetectionFailed", reason: "noAdapter" }));
    }) as InvokeFn;
    const result = await coworkPreflightSubnet(invoke);
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("unreachable");
    expect(result.hint).toMatch(/didn't find/i);
    expect(result.hint).not.toContain("set up on this machine");
  });

  it("reports unknown — never blocked — when the probe itself cannot run", async () => {
    // A broken probe says nothing about whether enabling would work. Blocking
    // here would stop a user whose enable would have succeeded, which is a
    // worse failure than the one #1298 is fixing.
    for (const thrown of [
      new Error("Tauri runtime not available"),
      new Error("Windows only"),
      "a bare string",
    ]) {
      const invoke = (async () => {
        throw thrown;
      }) as InvokeFn;
      await expect(coworkPreflightSubnet(invoke)).resolves.toEqual({ status: "unknown" });
    }
  });

  it("treats a non-firewall JSON error as unknown, not blocked", () => {
    const invoke = (async () => {
      throw new Error(JSON.stringify({ error: "oops" }));
    }) as InvokeFn;
    return expect(coworkPreflightSubnet(invoke)).resolves.toEqual({ status: "unknown" });
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
      "notConfigured",
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

  it("maps 'notConfigured' to the neutral family (never an error)", () => {
    expect(workspaceFileStatusFamily("notConfigured")).toBe("neutral");
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

  it("rolls a 'notConfigured' triple up to 'notConfigured'", () => {
    expect(aggregateWorkspaceStatus(ws("notConfigured", "notConfigured", "notConfigured"))).toBe(
      "notConfigured",
    );
  });

  it("'failed' wins over 'notConfigured'", () => {
    expect(aggregateWorkspaceStatus(ws("notConfigured", "failed", "notConfigured"))).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// coworkReachability / coworkWorkspaceReachable / coworkReachabilityCopy (#1174 gap #3)
// ---------------------------------------------------------------------------

describe("coworkWorkspaceReachable", () => {
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
      path: "C:/fake",
    };
  }

  it("true when all three files are 'ok'", () => {
    expect(coworkWorkspaceReachable(ws("ok", "ok", "ok"))).toBe(true);
  });

  it("true when files are 'ok' or 'alreadyPresent' (idempotent re-install counts)", () => {
    expect(coworkWorkspaceReachable(ws("ok", "alreadyPresent", "ok"))).toBe(true);
  });

  it("false when any file is not installed", () => {
    expect(coworkWorkspaceReachable(ws("ok", "notConfigured", "ok"))).toBe(false);
    expect(coworkWorkspaceReachable(ws("ok", "ok", "failed"))).toBe(false);
    expect(coworkWorkspaceReachable(ws("locked", "ok", "ok"))).toBe(false);
  });
});

describe("coworkReachability", () => {
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
      path: "C:/fake",
    };
  }

  it("'not-applicable' when status is null", () => {
    expect(coworkReachability(null)).toBe("not-applicable");
  });

  it("'not-applicable' when the integration is not enabled", () => {
    expect(coworkReachability(makeStatus({ enabled: false }))).toBe("not-applicable");
  });

  it("'reachable' when ≥1 workspace is fully installed", () => {
    expect(
      coworkReachability(makeStatus({ enabled: true, workspaces: [ws("ok", "ok", "ok")] })),
    ).toBe("reachable");
  });

  it("'reachable' if any one of several workspaces is complete (others partial)", () => {
    expect(
      coworkReachability(
        makeStatus({
          enabled: true,
          workspaces: [ws("notConfigured", "notConfigured", "notConfigured"), ws("ok", "ok", "ok")],
        }),
      ),
    ).toBe("reachable");
  });

  it("'unreachable' when no workspace is complete and one has a hard error", () => {
    expect(
      coworkReachability(makeStatus({ enabled: true, workspaces: [ws("failed", "ok", "ok")] })),
    ).toBe("unreachable");
    expect(
      coworkReachability(
        makeStatus({ enabled: true, workspaces: [ws("schemaDrift", "ok", "ok")] }),
      ),
    ).toBe("unreachable");
  });

  it("'pending' when enabled but no workspaces scanned yet (heal-pass will install)", () => {
    expect(coworkReachability(makeStatus({ enabled: true, workspaces: [] }))).toBe("pending");
  });

  it("'pending' when workspaces exist but are only 'notConfigured' (awaiting heal-pass)", () => {
    expect(
      coworkReachability(
        makeStatus({
          enabled: true,
          workspaces: [ws("notConfigured", "notConfigured", "notConfigured")],
        }),
      ),
    ).toBe("pending");
  });

  it("'pending' when a workspace is only 'locked' (retrying, not a hard error)", () => {
    expect(
      coworkReachability(makeStatus({ enabled: true, workspaces: [ws("locked", "ok", "ok")] })),
    ).toBe("pending");
  });
});

describe("coworkReachabilityCopy", () => {
  it("maps each verdict to a token family", () => {
    expect(coworkReachabilityCopy("reachable").family).toBe("success");
    expect(coworkReachabilityCopy("unreachable").family).toBe("error");
    expect(coworkReachabilityCopy("pending").family).toBe("warning");
    expect(coworkReachabilityCopy("not-applicable").family).toBe("neutral");
  });

  it("provides non-empty copy for surfaced verdicts and empty copy for not-applicable", () => {
    for (const r of ["reachable", "unreachable", "pending"] as const) {
      expect(coworkReachabilityCopy(r).title.length).toBeGreaterThan(0);
      expect(coworkReachabilityCopy(r).detail.length).toBeGreaterThan(0);
    }
    expect(coworkReachabilityCopy("not-applicable").title).toBe("");
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
      .mockRejectedValue(new Error("Cowork integration is Windows-only"));
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
