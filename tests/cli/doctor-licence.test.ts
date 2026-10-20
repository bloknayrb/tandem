import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLicence,
  licenceOffLabel,
  parseDoctorLicence,
  runDoctor,
} from "../../src/cli/doctor.js";

/**
 * Doctor's licence row (#1521). It reads `GET /api/license/status` once,
 * is SILENT on a dark build, a 404 and a non-answer (so a dark build's report is
 * unchanged), WARNS when the server answers but not readably (any other non-OK,
 * an unparsable body, an unknown status), and while AI is refused it is the one licence-caused warning —
 * the session reading, the push row and the SSE probe each defer to it (a
 * `skip` row with `reason: "license"`) rather than going yellow. Other checks
 * (config files, ports) can still warn for their own reasons.
 *
 * `runDoctor` backs the shareable `/api/diagnostics` report, so the row's
 * `data` must never carry the licence holder's email, which the loopback
 * status body does. The fixture also keeps a `name`, the shape a server from
 * before 2026-10-20 (when licenses still carried one) would send.
 */

const LICENSED_WITH_PII = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
  licenseId: "lic-secret-id",
  license: { name: "Jane Doe", email: "jane@example.com", type: "personal" },
};

describe("parseDoctorLicence", () => {
  it.each([
    ["no answer", null],
    ["a connection error", { error: "ECONNREFUSED" }],
    ["a 404 (older server)", { status: 404, data: null }],
    ["a dark build", { status: 200, data: { gateActive: false, status: "licensed" } }],
    ["a dark build's real wire (no status)", { status: 200, data: { gateActive: false } }],
  ])("is silent on %s", (_label, result) => {
    expect(parseDoctorLicence(result as never)).toBeNull();
    expect(evaluateLicence(parseDoctorLicence(result as never))).toBeNull();
  });

  // The server answered, just not readably. Silence here would read exactly
  // like a dark build, and the session rows would then claim what the licence
  // may contradict.
  it.each([
    ["a 401", { status: 401, data: null }, /License status unreadable \(HTTP 401\)/],
    ["a 500", { status: 500, data: { error: "boom" } }, /License status unreadable \(HTTP 500\)/],
    ["an unparsable body", { status: 200, data: null }, /unreadable \(unrecognised answer\)/],
    [
      "an unknown status string",
      { status: 200, data: { gateActive: true, status: "suspended" } },
      /unreadable \(unrecognised answer\)/,
    ],
    [
      "a gated body with no status",
      { status: 200, data: { gateActive: true } },
      /unreadable \(unrecognised answer\)/,
    ],
    [
      "a body with no gateActive",
      { status: 200, data: { status: "licensed" } },
      /unreadable \(unrecognised answer\)/,
    ],
  ])("warns that the status is unreadable on %s", (_label, result, message) => {
    const row = evaluateLicence(parseDoctorLicence(result as never));
    expect(row?.status).toBe("warn");
    expect(row?.message).toMatch(message);
    expect(row?.message).not.toMatch(/AI features on/);
    // Nothing from the body reaches the shareable report.
    expect(Object.keys(row?.data ?? {})).toEqual(["httpStatus"]);
    expect(licenceOffLabel(parseDoctorLicence(result as never))).toBeNull();
  });

  it.each(["trial", "licensed", "restricted"])(
    "reads the known status %s (positive twin)",
    (status) => {
      const parsed = parseDoctorLicence({
        status: 200,
        data: { gateActive: true, status },
      } as never);
      expect(parsed).toEqual({ gateActive: true, status, licenseUnverifiable: null });
      expect(evaluateLicence(parsed)?.message).not.toMatch(/unreadable/);
    },
  );

  it("keeps only gateActive, status and licenseUnverifiable", () => {
    const parsed = parseDoctorLicence({ status: 200, data: LICENSED_WITH_PII } as never);
    expect(parsed).toEqual({ gateActive: true, status: "licensed", licenseUnverifiable: null });
    const row = evaluateLicence(parsed);
    expect(Object.keys(row?.data ?? {}).sort()).toEqual([
      "gateActive",
      "licenseUnverifiable",
      "status",
    ]);
    expect(JSON.stringify(row)).not.toMatch(/Jane|jane@example\.com|lic-secret-id/);
  });
});

describe("evaluateLicence", () => {
  it("warns that AI is off when unlicensed", () => {
    const row = evaluateLicence({
      gateActive: true,
      status: "restricted",
      licenseUnverifiable: null,
    });
    expect(row?.status).toBe("warn");
    expect(row?.message).toMatch(/AI features off \(unlicensed\)/);
  });

  it("names an unverifiable licence as such", () => {
    const licence = {
      gateActive: true as const,
      status: "restricted" as const,
      licenseUnverifiable: "BAD_SIGNATURE",
    };
    expect(licenceOffLabel(licence)).toBe("(license not verified)");
    expect(evaluateLicence(licence)?.message).toMatch(/license not verified/);
  });

  it("passes on a trial (positive twin)", () => {
    const row = evaluateLicence({ gateActive: true, status: "trial", licenseUnverifiable: null });
    expect(row?.status).toBe("pass");
    expect(licenceOffLabel({ gateActive: true, status: "trial", licenseUnverifiable: null })).toBe(
      null,
    );
  });
});

describe("runDoctor with a licence answer", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function fakeTandem(
    licence: unknown,
    session: { hasSession: boolean; sessionCount: number } = { hasSession: false, sessionCount: 0 },
  ): Promise<number> {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            version: "0.0.0-test",
            transport: "http",
            ...session,
            push: { subscribers: 1, eventCount: 0, lastEventAt: null },
          }),
        );
        return;
      }
      if (req.url === "/api/license/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(licence));
        return;
      }
      if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": connected\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  it("restricted: one licence warning; push and SSE rows defer to it", async () => {
    const mcpPort = await fakeTandem({ gateActive: true, status: "restricted" });
    const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
    const licence = report.results.filter((r) => r.check === "license");
    expect(licence).toHaveLength(1);
    expect(licence[0].status).toBe("warn");
    const health = report.results.filter((r) => r.check === "health");
    expect(health.some((r) => /Push path not checked — AI features off/.test(r.message))).toBe(
      true,
    );
    expect(health.some((r) => /No real-time push consumer/.test(r.message))).toBe(false);
    const sse = report.results.filter((r) => r.check === "sse");
    expect(sse).toHaveLength(1);
    expect(sse[0].message).toMatch(/SSE event stream not checked/);
  });

  it("licensed: the push and SSE rows run as usual, and no PII reaches the report", async () => {
    const mcpPort = await fakeTandem(LICENSED_WITH_PII);
    const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
    const sse = report.results.filter((r) => r.check === "sse");
    expect(sse[0]?.message).toMatch(/reachable/);
    expect(JSON.stringify(report)).not.toMatch(/Jane|jane@example\.com|lic-secret-id/);
  });

  /**
   * #1521: while refused, doctor makes no session claim either way: the
   * session reading becomes a deferred `skip` (recorded as a `skipped` pass). A fresh
   * client's handshake is refused (so "hasn't connected yet" may be false) and
   * a client pinned by an open stream survives until its next request (so
   * "session active" may be false). These assert what doctor prints.
   */
  describe("the session reading while refused", () => {
    const sessionSkip = (report: Awaited<ReturnType<typeof runDoctor>>) =>
      report.results.filter(
        (r) => r.check === "health" && /MCP session not checked — AI features off/.test(r.message),
      );
    const healthText = (report: Awaited<ReturnType<typeof runDoctor>>) =>
      report.results
        .filter((r) => r.check === "health")
        .map((r) => r.message)
        .join("\n");

    it("no session: a deferred skip row, and no 'hasn't connected yet' warning", async () => {
      const mcpPort = await fakeTandem({ gateActive: true, status: "restricted" });
      const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
      const skip = sessionSkip(report);
      expect(skip).toHaveLength(1);
      // A `skip` outcome is recorded as a pass row marked `skipped`.
      expect(skip[0].data).toEqual({ reason: "license", skipped: true });
      expect(healthText(report)).not.toMatch(/hasn't connected yet/);
    });

    it("a live session: the same skip, and the pass line claims no 'session active'", async () => {
      const mcpPort = await fakeTandem(
        { gateActive: true, status: "restricted" },
        { hasSession: true, sessionCount: 1 },
      );
      const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
      expect(sessionSkip(report)).toHaveLength(1);
      expect(healthText(report)).not.toMatch(/session active/);
      expect(healthText(report)).toMatch(/Server healthy \(v0\.0\.0-test, http\)/);
    });

    it("the twin, not refused: no session still warns, and a live one is 'session active'", async () => {
      const none = await fakeTandem({ gateActive: true, status: "trial" });
      const r1 = await runDoctor({ mcpPort: none, wsPort: 1, vitePort: 1 });
      expect(sessionSkip(r1)).toHaveLength(0);
      expect(healthText(r1)).toMatch(/hasn't connected yet/);
      await new Promise<void>((resolve) => server?.close(() => resolve()));

      const live = await fakeTandem(
        { gateActive: true, status: "trial" },
        { hasSession: true, sessionCount: 1 },
      );
      const r2 = await runDoctor({ mcpPort: live, wsPort: 1, vitePort: 1 });
      expect(healthText(r2)).toMatch(/session active/);
    });
  });

  it("an erroring status route: one 'unreadable' warning, and the push and SSE rows still run", async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            version: "0.0.0-test",
            transport: "http",
            hasSession: false,
            sessionCount: 0,
            push: { subscribers: 1, eventCount: 0, lastEventAt: null },
          }),
        );
        return;
      }
      if (req.url === "/api/license/status") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "INTERNAL" }));
        return;
      }
      if (req.url === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": connected\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const mcpPort = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
    const licence = report.results.filter((r) => r.check === "license");
    expect(licence).toHaveLength(1);
    expect(licence[0].status).toBe("warn");
    expect(licence[0].message).toBe("License status unreadable (HTTP 500)");
    const sse = report.results.filter((r) => r.check === "sse");
    expect(sse[0]?.message).toMatch(/reachable/);
  });

  it("dark: no licence row at all", async () => {
    const mcpPort = await fakeTandem({ gateActive: false, status: "licensed" });
    const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
    expect(report.results.some((r) => r.check === "license")).toBe(false);
  });
});
