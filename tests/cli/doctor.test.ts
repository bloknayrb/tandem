import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateNpmStaleness,
  evaluateOrphanedVite,
  evaluateStaleGlobal,
  globalTandemEditorVersion,
  isTandemEditorRepo,
  runDoctor,
  runDoctorCli,
  summarizeDoctorResults,
} from "../../src/cli/doctor.js";
import { allocPort } from "../helpers/alloc-port.js";

// checkStaleGlobal (which calls globalTandemEditorVersion, which calls
// execFile) only runs its real logic when __TANDEM_VERSION__ is defined —
// tsup-injected, never true under vitest — so runDoctor()-based tests never
// invoke execFile. Mocking it here only affects the direct
// globalTandemEditorVersion() tests below.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

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

  // Malformed-but-valid-JSON locks: an object whose `pid` is the wrong type, or
  // an object with no `pid` at all. parseLockfile's JSON branch requires a
  // positive-integer `pid` and returns null otherwise (it does NOT fall back to
  // the legacy raw-PID parse for `{`-prefixed content), so doctor must report
  // "unparseable" rather than crash or mis-read the string as a PID.
  const malformedJsonCases: Array<[string, string]> = [
    ["string-typed pid", JSON.stringify({ pid: "28572", app: "tandem" })],
    ["object with no pid field", JSON.stringify({ app: "tandem", startedAtMs: 123 })],
  ];
  for (const [label, content] of malformedJsonCases) {
    it(`warns "unparseable" for a JSON lock with ${label}`, async () => {
      const annDir = join(dataDir, "annotations");
      mkdirSync(annDir, { recursive: true });
      writeFileSync(join(annDir, "store.lock"), content);

      const report = await runDoctor();
      const messages = report.results
        .filter((r) => r.check === "annotation-store")
        .map((r) => r.message);
      expect(messages.some((m) => m.includes("unparseable"))).toBe(true);
      // Must not mis-read the string "28572" as a live/dead PID.
      expect(messages.some((m) => m.includes("live PID") || m.includes("dead PID"))).toBe(false);
    });
  }

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

describe("evaluateStaleGlobal", () => {
  it("reports nothing when there is no global install", () => {
    expect(evaluateStaleGlobal("0.14.3", null)).toBeNull();
  });

  it("passes when the global version matches the bundled version", () => {
    const result = evaluateStaleGlobal("0.14.3", "0.14.3");
    expect(result).toMatchObject({ status: "pass" });
    expect(result?.message).toContain("0.14.3");
  });

  it("warns with an uninstall fix when the global version differs", () => {
    const result = evaluateStaleGlobal("0.14.3", "0.2.11");
    expect(result).toMatchObject({ status: "warn" });
    expect(result?.message).toContain("0.2.11");
    expect(result?.message).toContain("0.14.3");
    expect(result?.fix).toContain("npm uninstall -g tandem-editor");
    expect(result?.data).toEqual({ globalVersion: "0.2.11", bundledVersion: "0.14.3" });
  });
});

describe("globalTandemEditorVersion", () => {
  const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it("parses the version out of npm ls -g --json output", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(
        null,
        JSON.stringify({ dependencies: { "tandem-editor": { version: "0.2.11" } } }),
        "",
      );
    });

    await expect(globalTandemEditorVersion()).resolves.toBe("0.2.11");
  });

  it("resolves null when npm ls prints no stdout (npm absent or errored before output)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("spawn npm ENOENT"), "", "");
    });

    await expect(globalTandemEditorVersion()).resolves.toBeNull();
  });

  it("resolves null when stdout is not valid JSON", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "not json", "");
    });

    await expect(globalTandemEditorVersion()).resolves.toBeNull();
  });

  it("resolves null when tandem-editor is not among the global dependencies", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, JSON.stringify({ dependencies: {} }), "");
    });

    await expect(globalTandemEditorVersion()).resolves.toBeNull();
  });
});

describe("isTandemEditorRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-repo-gate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when package.json is absent", () => {
    expect(isTandemEditorRepo(dir)).toBe(false);
  });

  it("is false when package.json is malformed JSON", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(isTandemEditorRepo(dir)).toBe(false);
  });

  it("is false for someone else's package.json (global-install end-user cwd)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "left-pad" }));
    expect(isTandemEditorRepo(dir)).toBe(false);
  });

  it("is true when package.json names tandem-editor", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.16.0" }),
    );
    expect(isTandemEditorRepo(dir)).toBe(true);
  });
});

describe("evaluateNpmStaleness", () => {
  const pkg = { version: "1.0.0" };
  // Mirrors the real shape: the hidden lockfile omits the root "" entry AND
  // optional deps whose os/cpu exclude this machine (platform binaries).
  const freshLock = {
    version: "1.0.0",
    packages: {
      "": { version: "1.0.0" },
      "node_modules/foo": { version: "2.3.4" },
      "node_modules/plat-other-os": { version: "1.1.1", optional: true },
    },
  };
  const freshHidden = {
    version: "1.0.0",
    packages: { "node_modules/foo": { version: "2.3.4" } },
  };

  it("skips (null) when any input is missing or unreadable", () => {
    expect(evaluateNpmStaleness(null, freshLock, freshHidden)).toBeNull();
    expect(evaluateNpmStaleness(pkg, null, freshHidden)).toBeNull();
    expect(evaluateNpmStaleness(pkg, freshLock, null)).toBeNull();
  });

  it("passes on a fresh install — absent platform-optional deps are not drift", () => {
    const result = evaluateNpmStaleness(pkg, freshLock, freshHidden);
    expect(result).toMatchObject({ status: "pass" });
    expect(result?.fix).toBeUndefined();
  });

  it("warns with fix `npm install` when package.json outruns package-lock.json", () => {
    const result = evaluateNpmStaleness({ version: "1.1.0" }, freshLock, freshHidden);
    expect(result).toMatchObject({ status: "warn", fix: "npm install" });
    expect(result?.message).toContain("1.1.0");
    expect(result?.message).toContain("1.0.0");
  });

  it("warns when node_modules was installed from a different lockfile root version", () => {
    const hidden = { ...freshHidden, version: "0.9.0" };
    const result = evaluateNpmStaleness(pkg, freshLock, hidden);
    expect(result).toMatchObject({ status: "warn", fix: "npm install" });
    expect(result?.message).toContain("0.9.0");
  });

  it("warns when an installed package version drifts from the lockfile", () => {
    const hidden = {
      version: "1.0.0",
      packages: { "node_modules/foo": { version: "2.0.0" } },
    };
    const result = evaluateNpmStaleness(pkg, freshLock, hidden);
    expect(result).toMatchObject({ status: "warn", fix: "npm install" });
    expect(result?.data?.driftCount).toBe(1);
  });

  it("warns when a NON-optional lockfile package is missing from the installed tree", () => {
    const hidden = { version: "1.0.0", packages: {} };
    const result = evaluateNpmStaleness(pkg, freshLock, hidden);
    expect(result).toMatchObject({ status: "warn", fix: "npm install" });
    expect(result?.data?.driftCount).toBe(1);
  });

  it("warns when an extraneous package remains installed after removal from the lockfile", () => {
    const hidden = {
      version: "1.0.0",
      packages: {
        "node_modules/foo": { version: "2.3.4" },
        "node_modules/gone": { version: "0.1.0" },
      },
    };
    const result = evaluateNpmStaleness(pkg, freshLock, hidden);
    expect(result).toMatchObject({ status: "warn", fix: "npm install" });
  });
});

describe("evaluateOrphanedVite", () => {
  const ports = { wsPort: 3478, mcpPort: 3479 };

  it("reports nothing when no Vite server is listening", () => {
    expect(evaluateOrphanedVite({ viteUp: false, wsUp: false, mcpUp: false, ...ports })).toBeNull();
    expect(evaluateOrphanedVite({ viteUp: false, wsUp: true, mcpUp: true, ...ports })).toBeNull();
  });

  it("warns with a kill + restart fix when Vite is up but both backend ports are down", () => {
    const result = evaluateOrphanedVite({ viteUp: true, wsUp: false, mcpUp: false, ...ports });
    expect(result).toMatchObject({ status: "warn" });
    expect(result?.message).toContain("5173");
    expect(result?.message).toContain("3478");
    expect(result?.message).toContain("3479");
    expect(result?.fix).toContain("Kill");
    expect(result?.fix).toContain("npm run dev:standalone");
  });

  it("passes when Vite and the backend are both up", () => {
    const result = evaluateOrphanedVite({ viteUp: true, wsUp: true, mcpUp: true, ...ports });
    expect(result).toMatchObject({ status: "pass" });
  });

  it("does not flag an orphan while the backend is only partially up", () => {
    // Half-started/half-crashed backend is the ports check's finding.
    expect(
      evaluateOrphanedVite({ viteUp: true, wsUp: true, mcpUp: false, ...ports }),
    ).toMatchObject({ status: "pass" });
    expect(
      evaluateOrphanedVite({ viteUp: true, wsUp: false, mcpUp: true, ...ports }),
    ).toMatchObject({ status: "pass" });
  });
});

describe("dev-repo gating in runDoctor", () => {
  let repoDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tandem-gate-"));
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    rmSync(repoDir, { recursive: true, force: true });
  });

  function mockCwd(dir: string): void {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  }

  /** Seed a minimal tandem-editor checkout with a consistent lockfile trio. */
  function seedRepo(versions: { pkg: string; lock: string; hidden: string }): void {
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: versions.pkg }),
    );
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({
        name: "tandem-editor",
        version: versions.lock,
        lockfileVersion: 3,
        packages: { "": { version: versions.lock } },
      }),
    );
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".package-lock.json"),
      JSON.stringify({
        name: "tandem-editor",
        version: versions.hidden,
        lockfileVersion: 3,
        packages: {},
      }),
    );
  }

  it("skips both gated checks silently in a non-tandem cwd (global-install user)", async () => {
    // An end-user cwd with their OWN project's package.json — the exact case
    // the gate exists for: no warn, no fail, no mention at all.
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "someones-app", version: "9.9.9" }),
    );
    mockCwd(repoDir);

    const report = await runDoctor();
    const names = report.results.map((res) => res.check);
    expect(names).not.toContain("npm-staleness");
    expect(names).not.toContain("orphaned-vite");
  });

  it("warns npm-staleness (fix: npm install) in a tandem cwd with a stale lockfile", async () => {
    seedRepo({ pkg: "0.2.0", lock: "0.1.0", hidden: "0.1.0" });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result).toBeDefined();
    expect(result?.status).toBe("warn");
    expect(result?.fix).toBe("npm install");
  });

  it("passes npm-staleness in a tandem cwd with a fresh install", async () => {
    seedRepo({ pkg: "0.2.0", lock: "0.2.0", hidden: "0.2.0" });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result).toBeDefined();
    expect(result?.status).toBe("pass");
  });
});
