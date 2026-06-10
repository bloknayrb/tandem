import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor, runDoctorCli, summarizeDoctorResults } from "../../src/cli/doctor.js";
import { allocPort } from "../helpers/alloc-port.js";

// Doctor reads the annotation store from TANDEM_APP_DATA_DIR (env override in
// resolveAppDataDir). Point it at a temp dir so the annotation-store check is
// deterministic and never touches the real OS data dir.
let dataDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tandem-doctor-test-"));
  prevEnv = process.env.TANDEM_APP_DATA_DIR;
  process.env.TANDEM_APP_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevEnv;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runDoctor", () => {
  it("returns a well-formed report object with the documented schema", async () => {
    const report = await runDoctor();

    expect(report).toMatchObject({
      crashed: false,
      error: null,
    });
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.failures).toBe("number");
    expect(typeof report.warnings).toBe("number");
    expect(typeof report.summary).toBe("string");
    expect(Array.isArray(report.results)).toBe(true);

    // ok is the inverse of having any failures.
    expect(report.ok).toBe(report.failures === 0);
  });

  it("tags every result with check + status + message", async () => {
    const report = await runDoctor();
    expect(report.results.length).toBeGreaterThan(0);
    for (const res of report.results) {
      expect(typeof res.check).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(res.status);
      expect(typeof res.message).toBe("string");
    }
  });

  it("never reads process.argv or calls process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit must not be called by runDoctor");
    }) as never);
    await expect(runDoctor()).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("emits an annotation-store data block when the store dir exists", async () => {
    const annDir = join(dataDir, "annotations");
    mkdirSync(annDir, { recursive: true });
    writeFileSync(
      join(annDir, "abc123.json"),
      JSON.stringify({ schemaVersion: 3, annotations: [] }),
    );

    const report = await runDoctor();
    const storeResults = report.results.filter((r) => r.check === "annotation-store");
    expect(storeResults.length).toBeGreaterThan(0);

    const summaryResult = storeResults.find(
      (r) => r.data && typeof r.data.docCount === "number" && "totalBytes" in r.data,
    );
    expect(summaryResult).toBeDefined();
    expect(summaryResult?.data?.docCount).toBe(1);
    expect(summaryResult?.data?.corruptCount).toBe(0);
    expect(typeof summaryResult?.data?.totalBytes).toBe("number");

    // Schema version is surfaced from the sampled file.
    const schemaResult = storeResults.find((r) => r.data && "schemaVersion" in r.data);
    expect(schemaResult?.data?.schemaVersion).toBe(3);
  });

  it("reports a zeroed data block when the store dir does not exist", async () => {
    // dataDir exists but has no annotations/ subdir.
    const report = await runDoctor();
    const storeResults = report.results.filter((r) => r.check === "annotation-store");
    const withData = storeResults.find((r) => r.data && "docCount" in r.data);
    expect(withData?.data?.docCount).toBe(0);
    expect(withData?.data?.exists).toBe(false);
  });

  // The lock writer has shipped two formats: a bare integer PID and a JSON
  // object `{pid,...}`. Doctor must read both — a JSON lock used to be reported
  // as "unparseable content". process.pid is the live doctor process.
  const lockCases: Array<[string, string]> = [
    ["bare-PID format", String(process.pid)],
    ["JSON-object format", JSON.stringify({ pid: process.pid, startedAtMs: 123, app: "tandem" })],
  ];
  for (const [label, content] of lockCases) {
    it(`reads a live-PID store.lock in ${label} without warning "unparseable"`, async () => {
      const annDir = join(dataDir, "annotations");
      mkdirSync(annDir, { recursive: true });
      writeFileSync(join(annDir, "store.lock"), content);

      const report = await runDoctor();
      const messages = report.results
        .filter((r) => r.check === "annotation-store")
        .map((r) => r.message);

      expect(messages.some((m) => m.includes("unparseable"))).toBe(false);
      // A live PID resolves to the "held by live PID" pass branch.
      expect(messages.some((m) => m.includes(`live PID ${process.pid}`))).toBe(true);
    });
  }

  it('still warns "unparseable" when the lock is genuinely non-numeric', async () => {
    const annDir = join(dataDir, "annotations");
    mkdirSync(annDir, { recursive: true });
    writeFileSync(join(annDir, "store.lock"), "not-a-pid-at-all");

    const report = await runDoctor();
    const messages = report.results
      .filter((r) => r.check === "annotation-store")
      .map((r) => r.message);
    expect(messages.some((m) => m.includes("unparseable"))).toBe(true);
  });

  it('reports a dead PID (not "unparseable") for a JSON lock pointing at no live process', async () => {
    const annDir = join(dataDir, "annotations");
    mkdirSync(annDir, { recursive: true });
    // 2147483646 (INT32_MAX-1) is not a live PID on any realistic system.
    const deadPid = 2_147_483_646;
    writeFileSync(join(annDir, "store.lock"), JSON.stringify({ pid: deadPid, app: "tandem" }));

    const report = await runDoctor();
    const messages = report.results
      .filter((r) => r.check === "annotation-store")
      .map((r) => r.message);
    expect(messages.some((m) => m.includes("unparseable"))).toBe(false);
    expect(messages.some((m) => m.includes(`dead PID ${deadPid}`))).toBe(true);
  });

  it("treats a non-positive PID (pid:0) as invalid, not a live holder", async () => {
    const annDir = join(dataDir, "annotations");
    mkdirSync(annDir, { recursive: true });
    writeFileSync(join(annDir, "store.lock"), JSON.stringify({ pid: 0, app: "tandem" }));

    const report = await runDoctor();
    const messages = report.results
      .filter((r) => r.check === "annotation-store")
      .map((r) => r.message);
    // PID 0 isn't a real process — must not resolve to "held by live PID".
    expect(messages.some((m) => m.includes("live PID 0"))).toBe(false);
    expect(messages.some((m) => m.includes("unparseable"))).toBe(true);
  });

  it("probes the ports passed via opts, not the defaults", async () => {
    // /api/diagnostics threads the server's live (possibly TANDEM_PORT-
    // overridden) ports through here. OS-assigned free ports that we
    // immediately close are guaranteed NOT listening, so the check must
    // report exactly those numbers as down.
    const [wsPort, mcpPort] = await Promise.all([allocPort(), allocPort()]);

    const report = await runDoctor({ wsPort, mcpPort });
    const portsResult = report.results.find((r) => r.check === "ports");
    expect(portsResult).toBeDefined();
    expect(portsResult?.message).toContain(String(wsPort));
    expect(portsResult?.message).toContain(String(mcpPort));
    expect(portsResult?.data).toMatchObject({ ws: false, mcp: false });
  });
});

describe("summarizeDoctorResults", () => {
  // Shared by the CLI summary AND /api/diagnostics' filtered recomputation —
  // the equivalence class that matters is failures-AND-warnings: failures must
  // win, or a broken report ends "Tandem should work".
  it.each([
    { failures: 2, warnings: 0, expected: "2 issue(s) found.", why: "failures only" },
    {
      failures: 0,
      warnings: 3,
      expected: "3 warning(s) — Tandem should work, but check the items above.",
      why: "warnings only",
    },
    { failures: 1, warnings: 5, expected: "1 issue(s) found.", why: "failures outrank warnings" },
    { failures: 0, warnings: 0, expected: "All checks passed. Tandem is ready.", why: "all clear" },
  ])("$why → $expected", ({ failures, warnings, expected }) => {
    expect(summarizeDoctorResults(failures, warnings)).toBe(expected);
  });
});

describe("runDoctorCli --json printer", () => {
  it("emits a single valid JSON object on stdout", async () => {
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const exitCode = await runDoctorCli({ json: true });
    stdoutSpy.mockRestore();

    const combined = chunks.join("");
    // The whole stdout stream must be exactly one parseable JSON document.
    const parsed = JSON.parse(combined);
    expect(parsed).toMatchObject({ crashed: false, error: null });
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(typeof parsed.ok).toBe("boolean");

    // Exit code matches the failure count discriminant.
    expect(exitCode).toBe(parsed.failures > 0 ? 1 : 0);
  });

  it("does not leak human-readable [PASS]/[WARN]/[FAIL] lines into JSON stdout", async () => {
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    await runDoctorCli({ json: true });
    stdoutSpy.mockRestore();

    const combined = chunks.join("");
    expect(combined).not.toContain("[PASS]");
    expect(combined).not.toContain("[WARN]");
    expect(combined).not.toContain("[FAIL]");
  });

  it("prints human-readable lines (not JSON) in non-json mode", async () => {
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    await runDoctorCli({ json: false });
    stdoutSpy.mockRestore();

    const combined = chunks.join("");
    expect(combined).toContain("Tandem Doctor");
    // Status tags are present in human mode.
    expect(/\[(PASS|WARN|FAIL)\]/.test(combined)).toBe(true);
    // The whole stream is NOT a single JSON object.
    expect(() => JSON.parse(combined)).toThrow();
  });
});
