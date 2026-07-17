import { describe, expect, it, vi } from "vitest";
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

  it("threads the live ports into the collector", async () => {
    const collect = vi.fn(async () => makeReport([]));
    const handler = makeHandler(collect);

    await handler(makeMockReq("::1"), makeMockRes(), () => {});

    expect(collect).toHaveBeenCalledExactlyOnceWith({ wsPort: 1234, mcpPort: 5678 });
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
