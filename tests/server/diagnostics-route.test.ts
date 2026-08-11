import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorReport, DoctorResult } from "../../src/cli/doctor.js";
import {
  filterDevRepoChecks,
  makeDiagnosticsHandler,
} from "../../src/server/mcp/routes/diagnostics.js";

/**
 * Unit tests for GET /api/diagnostics. The collector is injected so no real
 * port probes / filesystem reads happen; what's under test is the route's
 * contract: loopback-only gate, dev-repo check filtering with recomputed
 * aggregates, generic 500 on collector crash, and single-flight collapsing
 * of concurrent requests (the collector self-probes the server's own ports,
 * so request bursts must not amplify into probe bursts).
 */

function result(check: string, status: DoctorResult["status"], message = "msg"): DoctorResult {
  return { check, status, message };
}

function makeReport(results: DoctorResult[]): DoctorReport {
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return {
    ok: failures === 0,
    crashed: false,
    failures,
    warnings,
    summary: failures > 0 ? `${failures} issue(s) found.` : "All checks passed. Tandem is ready.",
    error: null,
    results,
  };
}

/** Mock Express Response capturing status + json body. */
function makeMockRes() {
  const mock = {
    statusCode: 200,
    _body: null as Record<string, unknown> | null,
    status(code: number) {
      mock.statusCode = code;
      return mock;
    },
    json(body: Record<string, unknown>) {
      mock._body = body;
    },
  };
  return mock;
}

function makeMockReq(remoteAddress: string) {
  return { socket: { remoteAddress } };
}

type AnyHandler = (req: unknown, res: unknown, next: unknown) => Promise<void>;

function makeHandler(collect: (opts: unknown) => Promise<DoctorReport>) {
  return makeDiagnosticsHandler({
    version: "0.0.0-test",
    transport: "http",
    wsPort: 1234,
    mcpPort: 5678,
    collect,
  }) as unknown as AnyHandler;
}

/** Drive a one-shot handler and return what it wrote. */
async function invoke(
  collect: (opts: unknown) => Promise<DoctorReport>,
  remoteAddress = "127.0.0.1",
): Promise<{ status: number; body: Record<string, unknown>; report: DoctorReport }> {
  const res = makeMockRes();
  await makeHandler(collect)(makeMockReq(remoteAddress), res, () => {});
  const body = (res._body ?? {}) as Record<string, unknown>;
  return { status: res.statusCode, body, report: body.report as DoctorReport };
}

describe("GET /api/diagnostics — loopback happy path", () => {
  it("returns 200 with the report and environment fields", async () => {
    const collect = vi.fn(async () => makeReport([result("node-version", "pass")]));
    const handler = makeHandler(collect);
    const res = makeMockRes();

    await handler(makeMockReq("127.0.0.1"), res, () => {});

    expect(res.statusCode).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.version).toBe("0.0.0-test");
    expect(body.transport).toBe("http");
    expect(body.platform).toBe(process.platform);
    expect(body.arch).toBe(process.arch);
    expect(body.nodeVersion).toBe(process.version);
    expect(typeof body.tauriSidecar).toBe("boolean");
    const report = body.report as DoctorReport;
    expect(report.results).toHaveLength(1);
    expect(report.ok).toBe(true);
  });

  it("emits exactly the allowed key set — no hostname, username, or home path", async () => {
    // This payload reaches a public GitHub issue (Copy Diagnostics puts it on
    // the clipboard; Report-a-bug prefills it into an issue body), so the key
    // set is a privacy contract rather than a convenience. Asserting the whole
    // set — instead of `not.toContain(os.hostname())`, which flakes whenever
    // CI's hostname is a common substring — is what catches an accidental
    // `hostname` / `homedir` / `env` field added to `collectHostInfo`.
    const { body } = await invoke(async () => makeReport([result("node-version", "pass")]));

    expect(Object.keys(body).sort()).toEqual([
      "arch",
      "cpuCount",
      "cpuModel",
      "freeMemoryMb",
      "nodeVersion",
      "osRelease",
      "osVersion",
      "platform",
      "report",
      "tauriSidecar",
      "totalMemoryMb",
      "transport",
      "version",
    ]);
  });

  it("types the optional host fields when present, without pinning values", async () => {
    // CI containers legitimately omit cpuModel/cpuCount (`os.cpus()` returns []),
    // so assert shape rather than content.
    const { body } = await invoke(async () => makeReport([]));

    for (const key of ["osRelease", "osVersion", "cpuModel"]) {
      if (body[key] !== undefined) expect(typeof body[key]).toBe("string");
    }
    for (const key of ["cpuCount", "totalMemoryMb", "freeMemoryMb"]) {
      if (body[key] !== undefined) expect(typeof body[key]).toBe("number");
    }
    // os.version() is bounded so a long kernel banner can't dominate the report.
    if (typeof body.osVersion === "string") expect(body.osVersion.length).toBeLessThanOrEqual(120);
  });

  it("threads the live ports into the collector", async () => {
    const collect = vi.fn(async () => makeReport([]));
    const handler = makeHandler(collect);

    await handler(makeMockReq("::1"), makeMockRes(), () => {});

    expect(collect).toHaveBeenCalledExactlyOnceWith({ wsPort: 1234, mcpPort: 5678 });
  });
});

describe("GET /api/diagnostics — home-path redaction", () => {
  // Failure-safe: an inline unstub at the end of a test does not run when the
  // test fails, which would leak a fake app-data root into later cases.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("replaces the home directory with ~ in messages and fixes", async () => {
    // Several doctor checks interpolate the app-data dir, which sits under the
    // user's home and therefore carries their username — including on a PASSING
    // check that fires on the common first run.
    const home = os.homedir();
    const dir = path.join(home, "AppData", "Local", "tandem", "annotations");
    const collect = async () =>
      makeReport([
        {
          check: "annotation-store",
          status: "warn",
          message: `Annotation store dir not yet created (${dir})`,
          fix: `Check permissions on ${dir}`,
          // The `data` bag is free-form and the real annotation-store check puts
          // the raw directory in it. A message-only redaction leaves the
          // username on the wire — this is why the assertion below stringifies
          // the WHOLE body rather than checking the two obvious fields.
          data: { dir, docCount: 0, nested: { paths: [dir] } },
        },
      ]);
    const { body, report } = await invoke(collect);

    expect(JSON.stringify(body)).not.toContain(home);
    const [only] = report.results;
    expect(only.message).toContain("~");
    expect(only.fix).toContain("~");
    // The rest of the path must survive — redaction, not deletion.
    expect(only.message).toContain("annotations");
    // Deep scrub reaches nested objects and arrays inside `data`.
    const data = only.data as { dir: string; nested: { paths: string[] } };
    expect(data.dir.startsWith("~")).toBe(true);
    expect(data.nested.paths[0].startsWith("~")).toBe(true);
  });

  it("scrubs a collector-level error message", async () => {
    const home = os.homedir();
    const collect = async () => ({
      ...makeReport([]),
      error: `EACCES: permission denied, open '${path.join(home, "secret.json")}'`,
    });
    const { report } = await invoke(collect);

    const { error } = report;
    expect(error).not.toContain(home);
    expect(error).toContain("~");
  });

  it("redacts an app-data dir that resolves OUTSIDE the home directory", async () => {
    // `resolveAppDataDir()` honours TANDEM_APP_DATA_DIR / XDG_DATA_HOME /
    // LOCALAPPDATA, any of which can point off-home (redirected Windows
    // profile, custom XDG root on another volume). A $HOME-only redaction
    // leaves the username on the wire in exactly that configuration.
    vi.stubEnv("TANDEM_APP_DATA_DIR", "/srv/exports/bryan/tandem");
    const dir = "/srv/exports/bryan/tandem/annotations";
    const { body, report } = await invoke(async () =>
      makeReport([
        {
          check: "annotation-store",
          status: "pass",
          message: `Annotation store dir not yet created (${dir}) — first open will create it`,
          data: { dir },
        },
      ]),
    );

    expect(JSON.stringify(body)).not.toContain("/srv/exports/bryan");
    const [only] = report.results;
    expect(only.message).toContain("<app-data>/annotations");
  });

  it("redacts a user path that reached the report inside a raw fs error", async () => {
    // doctor.ts:1434 and :1541 interpolate `errMsg(err)`, whose text embeds an
    // absolute path no prefix list is guaranteed to cover.
    const { report } = await invoke(async () =>
      makeReport([
        {
          check: "annotation-store",
          status: "fail",
          message:
            "Annotation store dir unreadable: EACCES: permission denied, scandir '/home/someoneelse/.local/share/tandem'",
          fix: "Check permissions on /home/someoneelse/.local/share/tandem",
        },
      ]),
    );

    const [only] = report.results;
    expect(only.message).not.toContain("someoneelse");
    expect(only.fix).not.toContain("someoneelse");
    expect(only.message).toContain("/home/[user]/.local/share/tandem");
  });

  it("does not swallow an unrelated path that merely starts with a redaction root", async () => {
    // A naive replace turns "/var/lib/tandemfs/..." into "<app-data>fs/...".
    // The root is stubbed rather than derived from `os.homedir()`: a decoy built
    // from the real home is environment-dependent — under `/root` it is
    // `/rootfs/...` (untouched), but under `/home/runner` it is
    // `/home/runnerfs/...`, which the generic `/home/<x>` pass redacts on
    // purpose. `tests/shared/redact-user-paths.test.ts` covers the home-root
    // boundary deterministically.
    vi.stubEnv("TANDEM_APP_DATA_DIR", "/var/lib/tandem");
    const decoy = "/var/lib/tandemfs/mount/data";
    const { report } = await invoke(async () =>
      makeReport([result("ports", "pass", `scanned ${decoy}`)]),
    );

    const [only] = report.results;
    expect(only.message).toBe(`scanned ${decoy}`);
  });

  it("leaves messages without a home path untouched", async () => {
    const { report } = await invoke(async () =>
      makeReport([result("ports", "pass", "Hocuspocus :3478 and MCP :3479 are listening")]),
    );

    const [only] = report.results;
    expect(only.message).toBe("Hocuspocus :3478 and MCP :3479 are listening");
    expect(only.fix).toBeUndefined();
  });
});

describe("GET /api/diagnostics — dev-repo check filtering", () => {
  it("drops node-modules and mcp-json results and recomputes aggregates", async () => {
    // A Tauri/npm-global user's server cwd is arbitrary — these two checks
    // would FAIL on every field report. The route must not let them poison
    // ok/failures/summary.
    const collect = vi.fn(async () =>
      makeReport([
        result("node-version", "pass"),
        result("node-modules", "fail"),
        result("mcp-json", "fail"),
        result("mcp-json", "warn"),
        result("annotation-store", "warn"),
      ]),
    );
    const handler = makeHandler(collect);
    const res = makeMockRes();

    await handler(makeMockReq("127.0.0.1"), res, () => {});

    const report = (res._body as Record<string, unknown>).report as DoctorReport;
    expect(report.results.map((r) => r.check)).toEqual(["node-version", "annotation-store"]);
    expect(report.ok).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.warnings).toBe(1);
    expect(report.summary).toBe("1 warning(s) — Tandem should work, but check the items above.");
  });

  it("keeps real failures and their summary", () => {
    const filtered = filterDevRepoChecks(
      makeReport([result("node-modules", "fail"), result("ports", "fail")]),
    );
    expect(filtered.ok).toBe(false);
    expect(filtered.failures).toBe(1);
    expect(filtered.summary).toBe("1 issue(s) found.");
  });

  // ── Finding 13 ──
  // These three read process.cwd(). They self-gate on the cwd being a
  // tandem-editor checkout, but the gate is a property of the CWD, not of the
  // caller: an end user whose cwd happens to be a checkout — or, for
  // dev-repo, merely holds an unreadable package.json — would otherwise have
  // cwd-dependent findings recomputed into /api/diagnostics and Copy
  // Diagnostics. The self-gate is an optimization; this list is the contract.
  it.each([
    "npm-staleness",
    "orphaned-vite",
    "dev-repo",
  ])("strips the cwd-dependent %s check from field reports", (check) => {
    const filtered = filterDevRepoChecks(
      makeReport([result("node-version", "pass"), result(check, "warn")]),
    );
    expect(filtered.results.map((r) => r.check)).toEqual(["node-version"]);
    expect(filtered.warnings).toBe(0);
    expect(filtered.summary).toBe("All checks passed. Tandem is ready.");
  });
});

describe("GET /api/diagnostics — loopback gate", () => {
  it("returns 403 for non-loopback callers without running the collector", async () => {
    const collect = vi.fn(async () => makeReport([]));
    const handler = makeHandler(collect);
    const res = makeMockRes();

    await handler(makeMockReq("192.168.1.100"), res, () => {});

    expect(res.statusCode).toBe(403);
    expect(collect).not.toHaveBeenCalled();
    // The 403 body must not embed any report material.
    expect("report" in (res._body as Record<string, unknown>)).toBe(false);
  });

  it("fails closed when remoteAddress is undefined", async () => {
    const collect = vi.fn(async () => makeReport([]));
    const handler = makeHandler(collect);
    const res = makeMockRes();

    await handler({ socket: {} }, res, () => {});

    expect(res.statusCode).toBe(403);
    expect(collect).not.toHaveBeenCalled();
  });
});

describe("GET /api/diagnostics — collector crash", () => {
  it("returns a generic 500 with no error detail on the wire", async () => {
    const handler = makeHandler(async () => {
      throw new Error("EACCES: C:\\Users\\someone\\secret\\path");
    });
    const res = makeMockRes();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handler(makeMockReq("127.0.0.1"), res, () => {});
    } finally {
      errSpy.mockRestore();
    }

    expect(res.statusCode).toBe(500);
    expect(res._body).toEqual({ error: "diagnostics failed" });
  });

  it("recovers on the next request after a crash", async () => {
    let calls = 0;
    const handler = makeHandler(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return makeReport([result("node-version", "pass")]);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = makeMockRes();
      await handler(makeMockReq("127.0.0.1"), first, () => {});
      expect(first.statusCode).toBe(500);

      const second = makeMockRes();
      await handler(makeMockReq("127.0.0.1"), second, () => {});
      expect(second.statusCode).toBe(200);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("GET /api/diagnostics — single-flight", () => {
  it("shares one in-flight collector run across concurrent requests", async () => {
    let release!: (report: DoctorReport) => void;
    const gate = new Promise<DoctorReport>((resolve) => {
      release = resolve;
    });
    const collect = vi.fn(() => gate);
    const handler = makeHandler(collect);

    const resA = makeMockRes();
    const resB = makeMockRes();
    const inFlight = Promise.all([
      handler(makeMockReq("127.0.0.1"), resA, () => {}),
      handler(makeMockReq("127.0.0.1"), resB, () => {}),
    ]);
    release(makeReport([result("node-version", "pass")]));
    await inFlight;

    expect(collect).toHaveBeenCalledOnce();
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect((resA._body as Record<string, unknown>).report).toBeDefined();
    expect((resB._body as Record<string, unknown>).report).toBeDefined();
  });

  it("runs a fresh collection once the previous one settles", async () => {
    const collect = vi.fn(async () => makeReport([]));
    const handler = makeHandler(collect);

    await handler(makeMockReq("127.0.0.1"), makeMockRes(), () => {});
    await handler(makeMockReq("127.0.0.1"), makeMockRes(), () => {});

    expect(collect).toHaveBeenCalledTimes(2);
  });
});
