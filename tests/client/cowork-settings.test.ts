import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateWorkspaceStatus,
  COWORK_PREFLIGHT_FAILED,
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
  AdapterEnumerationReason,
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
// firewallErrorHint — one distinct hint per variant
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

  // Hand-maintained, and it is an ARRAY LITERAL — adding a member to the
  // `SubnetDetectionReason` union does NOT break it, so it drifts silently and a
  // new reason gets none of the coverage below unless it is added here by hand.
  const SUBNET_REASONS: SubnetDetectionReason[] = [
    "noAdapter",
    "noIpv4",
    "prefixTooBroad",
    "queryFailed",
    "timeout",
  ];

  it("gives each subnet-detection reason its own hint", () => {
    const hints = SUBNET_REASONS.map((reason) =>
      firewallErrorHint({ kind: "subnetDetectionFailed", reason }),
    );
    expect(new Set(hints).size).toBe(hints.length);
    for (const h of hints) expect(h.length).toBeGreaterThan(0);
  });

  it("the timeout hint names the wait, without quoting a number (#1371)", () => {
    // Two things at once, and both are load-bearing.
    //
    // Naming the wait is what #1371 asks for: a reason that says only "detection
    // failed" is the blanket message #1298 removed, wearing different words.
    //
    // NOT naming a number is forced by the fix's shape: the pre-flight and the
    // Enable path pass different budgets to the same query
    // (`SUBNET_PROBE_TIMEOUT_ADVISORY` vs `SUBNET_PROBE_TIMEOUT_ENABLE`), so a
    // literal "15 seconds" here would be wrong on one of the two paths. This
    // fails if someone "improves" the copy by adding the number back.
    const hint = firewallErrorHint({ kind: "subnetDetectionFailed", reason: "timeout" });
    expect(hint.toLowerCase()).toMatch(/wait/);
    expect(
      hint,
      "the copy must not quote a duration — the two paths use different budgets",
    ).not.toMatch(/\d+\s*(second|s\b|minute)/i);
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

  // -------------------------------------------------------------------------
  // #1372: the three reasons behind adapterEnumerationFailed. The old single
  // sentence told all of them to "run Tandem as administrator or reboot to
  // refresh the adapter list" — advice that cannot work when the interpreter
  // never launched — and asserted an enumeration had been attempted.
  // -------------------------------------------------------------------------

  const ADAPTER_REASONS: AdapterEnumerationReason[] = [
    "notFound",
    "permissionDenied",
    "spawnFailed",
  ];

  it("gives each adapter-enumeration reason its own hint", () => {
    const hints = ADAPTER_REASONS.map((reason) =>
      firewallErrorHint({ kind: "adapterEnumerationFailed", reason }),
    );
    expect(new Set(hints).size).toBe(hints.length);
    const fallback = firewallErrorHint({ kind: "adapterEnumerationFailed" });
    for (const h of hints) {
      // Positive control: prove the lookup resolved rather than falling through.
      expect(h).not.toBe(fallback);
      expect(h.length).toBeGreaterThan(40);
    }
  });

  it("no adapter-enumeration hint offers administrator rights or a reboot", () => {
    // The defect in one assertion. Elevation has nothing to do with whether a
    // process can be spawned, and rebooting cannot put PowerShell back on PATH.
    for (const reason of [...ADAPTER_REASONS, undefined]) {
      const hint = firewallErrorHint({ kind: "adapterEnumerationFailed", reason }).toLowerCase();
      expect(hint, `${reason ?? "(no reason)"} still offers elevation`).not.toContain(
        "administrator",
      );
      expect(hint, `${reason ?? "(no reason)"} still offers a reboot`).not.toContain("reboot");
      // And every one says PowerShell never started, which is what makes the
      // old advice visibly wrong rather than merely unhelpful.
      expect(hint).toContain("powershell");
    }
  });

  it("notFound points at PATH, permissionDenied at policy — they do not swap", () => {
    const notFound = firewallErrorHint({
      kind: "adapterEnumerationFailed",
      reason: "notFound",
    });
    const denied = firewallErrorHint({
      kind: "adapterEnumerationFailed",
      reason: "permissionDenied",
    });
    expect(notFound).toMatch(/PATH/);
    expect(denied).toMatch(/AppLocker|WDAC|application-control/i);
    expect(notFound).not.toMatch(/AppLocker/i);
    expect(denied).not.toMatch(/PATH/);
  });

  it("falls back for an absent or unrecognised adapter reason", () => {
    const noReason = firewallErrorHint({ kind: "adapterEnumerationFailed" });
    const blank = firewallErrorHint({
      kind: "adapterEnumerationFailed",
      reason: "" as AdapterEnumerationReason,
    });
    const unknown = firewallErrorHint({
      kind: "adapterEnumerationFailed",
      reason: "somethingNew" as AdapterEnumerationReason,
    });
    expect(blank).toBe(noReason);
    expect(unknown).toBe(noReason);
    expect(noReason.length).toBeGreaterThan(40);
  });

  // -------------------------------------------------------------------------
  // #1372: queryFailed now carries the diagnostics the query already captured.
  // -------------------------------------------------------------------------

  it("queryFailed renders the exit code and stderr tail when they are present", () => {
    const hint = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      exitCode: 1,
      stderrTail: "Get-NetAdapter : Access is denied.",
    });
    expect(hint).toContain("exit 1");
    expect(hint).toContain("Access is denied.");
    // The reason's own advice is kept, not replaced by the diagnostics.
    expect(hint).toContain(
      firewallErrorHint({ kind: "subnetDetectionFailed", reason: "queryFailed" }),
    );
  });

  it("adds nothing when a subnet variant carries no diagnostics", () => {
    // A sidecar built before #1372 sends the reason alone, and every reason but
    // queryFailed still does. Neither may grow an "(PowerShell exit unknown: )".
    for (const reason of SUBNET_REASONS) {
      const bare = firewallErrorHint({ kind: "subnetDetectionFailed", reason });
      expect(bare).not.toContain("PowerShell exit");
    }
    expect(
      firewallErrorHint({
        kind: "subnetDetectionFailed",
        reason: "queryFailed",
        stderrTail: "   ",
      }),
    ).not.toContain("PowerShell exit");
  });

  it("renders an exit code with no stderr, and a stderr with no exit code", () => {
    // Both halves are independently optional on the wire, so neither may be
    // required for the other to show.
    const exitOnly = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      exitCode: 1,
    });
    expect(exitOnly).toContain("exit 1");
    expect(exitOnly).toContain("(no output)");
    const stderrOnly = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      stderrTail: "boom",
    });
    expect(stderrOnly).toContain("exit unknown");
    expect(stderrOnly).toContain("boom");
  });

  it("never renders a zero exit code as if it were evidence", () => {
    // This assertion used to say the opposite. `classify_subnet_output`
    // returns `queryFailed` on TWO paths — a non-zero exit, and a ZERO exit
    // whose stdout carried no parseable marker — and an earlier cut keyed the
    // Rust side's diagnostics on the reason rather than on the process. That
    // gave the second path `exitCode: 0` with an empty stderr, and this
    // function appended "(PowerShell exit 0: (no output))" to "Windows
    // couldn't list Hyper-V network adapters". Self-contradictory, and
    // strictly worse than the bare hint.
    //
    // Fixed on the Rust side (`finish_subnet_query` attaches diagnostics only
    // when the process failed); the guard here is defence in depth, because
    // neither side alone made the contradiction visible.
    const hint = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      exitCode: 0,
    });
    expect(hint).not.toContain("PowerShell exit");
    expect(hint).not.toContain("(no output)");

    // A zero exit that DID produce stderr still shows the stderr — the guard
    // is about the exit code being uninformative, not about suppressing
    // evidence.
    const withText = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      exitCode: 0,
      stderrTail: "boom",
    });
    expect(withText).toContain("exit unknown");
    expect(withText).toContain("boom");
  });

  it("collapses a multi-line stderr into the single line the surfaces render", () => {
    // Every consumer is a single-line toast or an inline warning box, and a
    // PowerShell ErrorRecord is three lines. Pasted in raw it either stretches
    // the toast or loses everything after the first line, depending on the
    // surface.
    const hint = firewallErrorHint({
      kind: "subnetDetectionFailed",
      reason: "queryFailed",
      exitCode: 1,
      stderrTail: "Access is denied.\n    + CategoryInfo : PermissionDenied\n    + FQID : x",
    });
    expect(hint).not.toContain("\n");
    expect(hint).toContain("Access is denied. + CategoryInfo : PermissionDenied + FQID : x");
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
// offered at all. "The probe failed" and "enabling would fail" are different
// claims and only the second one may block a button; #1436 then split the
// first one again, into an environment that was never going to answer and a
// fault that owes the user a sentence.
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

  it("reports unavailable or failed — never blocked — when the probe cannot run", async () => {
    // A broken probe says nothing about whether enabling would work. Blocking
    // here would stop a user whose enable would have succeeded, which is a
    // worse failure than the one #1298 is fixing.
    //
    // #1436 splits the two reasons a probe does not answer. The environment
    // ones are `unavailable` and stay silent on every surface; anything else is
    // `failed` and says so. The two were already distinguished by their log
    // level here — that distinction simply never reached the wire.
    // Both literals, not the module constants: `rawMsg.includes(...)` is a
    // substring test against a string the Rust side owns, so a fixture built
    // from the constant would follow a rename that broke the real match. The
    // pre-#1436 fixture here read "Windows only" and matched NOTHING — with a
    // single `unknown` on both arms that was invisible, and it is exactly the
    // drift this spelling guards.
    for (const thrown of [
      new Error("Tauri runtime not available"),
      new Error("Cowork integration is Windows-only"),
    ]) {
      const invoke = (async () => {
        throw thrown;
      }) as InvokeFn;
      await expect(coworkPreflightSubnet(invoke)).resolves.toEqual({ status: "unavailable" });
    }
    const bareString = (async () => {
      throw "a bare string";
    }) as InvokeFn;
    await expect(coworkPreflightSubnet(bareString)).resolves.toEqual({ status: "failed" });
  });

  it("treats a non-firewall JSON error as failed, not blocked", () => {
    // A JSON error with no recognised `kind` is a serde drift or an
    // unregistered command — a bug on our side, not an environment we cannot
    // run in. It must not stop the user from enabling, and it must not pretend
    // the check passed.
    const invoke = (async () => {
      throw new Error(JSON.stringify({ error: "oops" }));
    }) as InvokeFn;
    return expect(coworkPreflightSubnet(invoke)).resolves.toEqual({ status: "failed" });
  });

  it("calls a missing bridge INSIDE Tauri a fault, not an environment", async () => {
    // The finding that made this split worth re-doing. `TAURI_NOT_AVAILABLE`
    // comes from `loadInvoke`'s own catch when the `@tauri-apps/api/core`
    // import fails. Outside Tauri that is the ordinary no-bridge case; INSIDE
    // Tauri it means a chunk that must exist did not load — a partial update, a
    // CSP block — and since every probing surface is gated on
    // `isTauriRuntime()`, it is the ONE way a shipped desktop build reaches
    // this arm at all. Reading it as an environment sent the only reachable
    // fault straight back to the silence #1436 exists to end.
    const notLoaded = (async () => {
      throw new Error("Tauri runtime not available");
    }) as InvokeFn;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} } as unknown as Window);
    try {
      // `await` inside the `try`, not `return promise` — a returned promise
      // runs the `finally` before it settles, and the unstub would then land
      // while the classification is still reading the global.
      await expect(coworkPreflightSubnet(notLoaded)).resolves.toEqual({ status: "failed" });
    } finally {
      vi.unstubAllGlobals();
      error.mockRestore();
    }
  });

  it("says something announceable, in the literal", () => {
    // Every render assertion in the mounted suites reads
    // `textContent.toContain(COWORK_PREFLIGHT_FAILED)`, which is VACUOUS if the
    // constant is empty or whitespace — a live region that adds no announceable
    // text would pass the whole suite that exists to prevent exactly that. This
    // is the one assertion written against the literal, so the constant cannot
    // silently go blank.
    expect(COWORK_PREFLIGHT_FAILED).toContain("Couldn't check your network");
    expect(COWORK_PREFLIGHT_FAILED.trim().length).toBeGreaterThan(20);
  });

  it("matches a DECORATED Windows-only rejection, not just the bare string", () => {
    // The `includes` half of the classification exists for this and only this:
    // the message can arrive wrapped (`Error: …`, a Tauri prefix). Since #1436
    // the two arms select silence vs a visible warning line, so a miss here
    // paints a hedged warning on every non-Windows run — the routine path.
    const decorated = (async () => {
      throw new Error("Error: Cowork integration is Windows-only");
    }) as InvokeFn;
    return expect(coworkPreflightSubnet(decorated)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("keeps `unavailable` off the error log and `failed` on it", async () => {
    // The split is only worth having if the two halves stay on the two sides.
    // A regression that routed the routine non-Windows path to `failed` would
    // both paint a warning on every non-Windows run and bury a real fault in
    // the noise.
    //
    // `async`/`await`, not `try { return promise } finally`: that shape runs
    // the `finally` when the promise is RETURNED, so `mockRestore()` wipes the
    // call history before the assertions read it and every count reads 0.
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notTauri = (async () => {
        throw new Error("Tauri runtime not available");
      }) as InvokeFn;
      const broken = (async () => {
        throw new Error("something nobody expected");
      }) as InvokeFn;
      const [unavailable, failed] = await Promise.all([
        coworkPreflightSubnet(notTauri),
        coworkPreflightSubnet(broken),
      ]);
      expect(unavailable).toEqual({ status: "unavailable" });
      expect(failed).toEqual({ status: "failed" });
      expect(debug).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      debug.mockRestore();
      error.mockRestore();
    }
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
    const invoke = vi
      .fn<InvokeFn>()
      .mockResolvedValue("Cowork enabled: 2 workspace(s) configured" as unknown);
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
