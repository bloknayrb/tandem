import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLicence,
  licenceOffLabel,
  parseDoctorLicence,
  runDoctor,
} from "../../src/cli/doctor.js";

/**
 * Doctor's licence row (#1521 §2d). It reads `GET /api/license/status` once,
 * is SILENT on a dark build and on any non-answer (so a dark build's report is
 * unchanged), and while AI is refused it is the one warning — the push row and
 * the SSE probe defer to it rather than each going yellow.
 *
 * `runDoctor` backs the shareable `/api/diagnostics` report, so the row's
 * `data` must never carry the licence holder's name or email, which the
 * loopback status body does.
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
    ["an unparsable body", { status: 200, data: null }],
    ["a dark build", { status: 200, data: { gateActive: false, status: "licensed" } }],
  ])("is silent on %s", (_label, result) => {
    expect(parseDoctorLicence(result as never)).toBeNull();
    expect(evaluateLicence(parseDoctorLicence(result as never))).toBeNull();
  });

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
      status: "restricted",
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

  async function fakeTandem(licence: unknown): Promise<number> {
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

  it("dark: no licence row at all", async () => {
    const mcpPort = await fakeTandem({ gateActive: false, status: "licensed" });
    const report = await runDoctor({ mcpPort, wsPort: 1, vitePort: 1 });
    expect(report.results.some((r) => r.check === "license")).toBe(false);
  });
});
