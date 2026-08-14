import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateAbsentChannelEntry,
  evaluateClaudeCli,
  evaluateNodeToolchain,
  evaluateNpmStaleness,
  evaluateOrphanedVite,
  evaluatePushPath,
  evaluateSpawnedEntryCommand,
  evaluateStaleGlobal,
  evaluateTandemPlugin,
  globalTandemEditorVersion,
  isTandemEditorRepo,
  probeTandemEditorRepo,
  runDoctor,
  runDoctorCli,
  summarizeDoctorResults,
} from "../../src/cli/doctor.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * Stand up a server that answers `/@vite/client` with 200, like a real Vite
 * dev server — on an EPHEMERAL port, so the suite never contends for the real
 * :5173 (a running `npm run dev:client` would otherwise flip these tests).
 *
 * `serveViteClient: false` models the other case the identity probe exists
 * for: something is listening on the port, but it is not Vite.
 */
async function fakeViteServer({
  serveViteClient = true,
}: {
  serveViteClient?: boolean;
} = {}): Promise<{ port: number; [Symbol.asyncDispose](): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (serveViteClient && req.url === "/@vite/client") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export const createHotContext = () => {};\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await allocPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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

// ── Finding 3: one malformed lockfile entry took down the WHOLE report ──
describe("a crashing check does not take down the report", () => {
  let repoDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it("still reports every other check when one check throws", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "tandem-crash-"));
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    // A lockfile whose `packages` map has a null entry — the exact input that
    // used to throw `TypeError: Cannot read properties of null` out of the
    // pure evaluator, past runDoctor, and out of the CLI as "crashed", exit 2.
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({
        version: "0.2.0",
        lockfileVersion: 3,
        packages: { "": { version: "0.2.0" }, "node_modules/x": null },
      }),
    );
    writeFileSync(
      join(repoDir, "node_modules", ".package-lock.json"),
      JSON.stringify({ version: "0.2.0", lockfileVersion: 3, packages: {} }),
    );
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoDir);

    const report = await runDoctor();
    expect(report.crashed).toBe(false);
    expect(report.results.map((res) => res.check)).toContain("node-version");
    expect(report.results.map((res) => res.check)).toContain("annotation-store");
  });
});

// ── "server not running" fix hint must match the install kind ──
// A source checkout starts the server with `npm run dev:standalone`; a
// global/desktop install has no such script. Pointing a global user at
// `dev:standalone` is the dead-end this branch exists to prevent — so the
// NEGATIVE assertion below (the global fix must NOT say dev:standalone) is the
// load-bearing one. A future refactor that collapses/flips the ternary would
// otherwise silently reintroduce the friction bug with green tests.
describe("'server not running' fix hint is install-kind aware", () => {
  let repoDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  /**
   * Seed a cwd whose package.json `name` decides the dev-repo gate, then run
   * doctor against two guaranteed-down ports (OS-assigned then immediately
   * closed) so the ports check takes its fail path and exposes `.fix`.
   */
  async function portsFixInCwd(pkgName: string): Promise<string | undefined> {
    repoDir = mkdtempSync(join(tmpdir(), "tandem-starthint-"));
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: pkgName, version: "0.2.0" }),
    );
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoDir);

    const [wsPort, mcpPort] = await Promise.all([allocPort(), allocPort()]);
    const report = await runDoctor({ wsPort, mcpPort });
    return report.results.find((res) => res.check === "ports")?.fix;
  }

  it("points a dev checkout at npm run dev:standalone", async () => {
    const fix = await portsFixInCwd("tandem-editor");
    expect(fix).toContain("dev:standalone");
  });

  it("points a global/desktop install at the app, NOT dev:standalone", async () => {
    const fix = await portsFixInCwd("someones-app");
    expect(fix).toBeDefined();
    expect(fix).not.toContain("dev:standalone");
    expect(fix).toContain("desktop app");
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

describe("evaluateClaudeCli", () => {
  it("passes when the CLI is on PATH", () => {
    const result = evaluateClaudeCli("INSTALLED_ON_PATH");
    expect(result.status).toBe("pass");
    expect(result.fix).toBeUndefined();
  });

  it("warns with a PATH fix when installed but not on PATH", () => {
    const result = evaluateClaudeCli("INSTALLED_NOT_ON_PATH");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not on PATH");
    expect(result.fix).toContain("PATH");
  });

  it("warns with an install fix when the CLI is absent", () => {
    const result = evaluateClaudeCli("NOT_INSTALLED");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not found");
    expect(result.fix).toContain("claude.com/claude-code");
  });

  it("tells the user to restart Tandem, not just open a new terminal", () => {
    // Doctor reads its own fresh process's PATH; the launcher spawns from the
    // long-running server's env captured at start. A new terminal fixes what
    // doctor sees, not what the launcher uses.
    const result = evaluateClaudeCli("INSTALLED_NOT_ON_PATH");
    expect(result.fix).toContain("restart Tandem");
  });

  it("warns instead of passing when on PATH but not launchable", () => {
    const result = evaluateClaudeCli("INSTALLED_ON_PATH", false);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("shim");
    expect(result.fix).toContain("TANDEM_CLAUDE_CMD");
  });

  it("keeps the PATH message for INSTALLED_NOT_ON_PATH regardless of launchability", () => {
    // The shim branch's text says "on PATH", and a shim on PATH always detects
    // as INSTALLED_ON_PATH — so this pairing can't arise from the real
    // detector. If it ever did, the honest answer is the not-on-PATH one, not a
    // message that contradicts its own presence value.
    const result = evaluateClaudeCli("INSTALLED_NOT_ON_PATH", false);
    expect(result.message).toContain("not on PATH");
  });

  it("defaults to launchable so a caller that can't answer gets today's behavior", () => {
    expect(evaluateClaudeCli("INSTALLED_ON_PATH").status).toBe("pass");
    expect(evaluateClaudeCli("INSTALLED_ON_PATH", true).status).toBe("pass");
  });

  it("keeps the not-installed message when nothing is installed at all", () => {
    // The shim branch is gated on something being found — a machine with no
    // CLI must not be told its CLI is a shim.
    const result = evaluateClaudeCli("NOT_INSTALLED", false);
    expect(result.message).toContain("not found");
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

describe("probeTandemEditorRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-repo-probe-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is "no" when package.json is absent — an arbitrary cwd is not a finding', () => {
    expect(probeTandemEditorRepo(dir)).toBe("no");
  });

  it('is "no" for someone else\'s package.json', () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "someones-app" }));
    expect(probeTandemEditorRepo(dir)).toBe("no");
  });

  it('is "yes" when package.json names tandem-editor', () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tandem-editor" }));
    expect(probeTandemEditorRepo(dir)).toBe("yes");
  });

  // ── Finding 6: "not the repo" and "the repo is corrupt" were the same answer ──
  it('is "unreadable" (NOT "no") for malformed JSON', () => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(probeTandemEditorRepo(dir)).toBe("unreadable");
  });

  it('is "unreadable" when package.json is not an object', () => {
    writeFileSync(join(dir, "package.json"), '"a string"');
    expect(probeTandemEditorRepo(dir)).toBe("unreadable");
  });

  it('is "unreadable" for a merge-conflicted package.json', () => {
    // The highest-value real case: the file exists, is obviously broken, and
    // used to be reported as simply "not the repo".
    writeFileSync(
      join(dir, "package.json"),
      '<<<<<<< HEAD\n{"name":"tandem-editor"}\n=======\n{"name":"tandem-editor"}\n>>>>>>> main\n',
    );
    expect(probeTandemEditorRepo(dir)).toBe("unreadable");
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

  // ── Finding 1: PASS on a tree that compared nothing ──
  describe("only passes after comparing something (packages dimension)", () => {
    it("skips a lockfileVersion 1 lockfile instead of passing", () => {
      // v1 lockfiles use `dependencies`, not `packages` — nothing to compare.
      const result = evaluateNpmStaleness(pkg, { version: "1.0.0" }, { version: "1.0.0" });
      expect(result?.status).toBe("skip");
      expect(result?.message).toContain("cannot compare");
      expect(result?.data?.reason).toBe("no-comparable-packages");
    });

    it("skips when both lockfiles are literally empty objects", () => {
      const result = evaluateNpmStaleness({}, {}, {});
      expect(result?.status).toBe("skip");
    });

    it("skips a ROOT-ONLY packages map — non-empty, but it compares nothing", () => {
      // The drift loop `continue`s on the "" entry, so a non-empty check
      // would let this exact shape through as a confident green.
      const rootOnly = { version: "1.0.0", packages: { "": { version: "1.0.0" } } };
      const result = evaluateNpmStaleness(pkg, rootOnly, { version: "1.0.0", packages: {} });
      expect(result?.status).toBe("skip");
      expect(result?.data?.reason).toBe("no-comparable-packages");
    });

    it("still WARNS on real drift — an empty installed tree is a finding, not a skip", () => {
      // Guard against over-correcting: `wanted` is the source of truth, so an
      // empty INSTALLED tree must stay the drift warn this check exists for.
      const result = evaluateNpmStaleness(pkg, freshLock, { version: "1.0.0", packages: {} });
      expect(result).toMatchObject({ status: "warn", fix: "npm install" });
    });
  });

  // ── Finding 4: a missing version silently disabled the version guard ──
  describe("only passes after comparing something (version dimension)", () => {
    const pkgs = { "node_modules/foo": { version: "2.3.4" } };
    const lock = { version: "1.0.0", packages: { "": { version: "1.0.0" }, ...pkgs } };
    const hidden = { version: "1.0.0", packages: pkgs };

    it("does not PASS when package.json has no version field", () => {
      const result = evaluateNpmStaleness({}, lock, hidden);
      expect(result?.status).toBe("skip");
      expect(result?.data?.missingVersions).toEqual(["package.json"]);
    });

    it("does not PASS when neither lockfile carries a version", () => {
      const result = evaluateNpmStaleness(
        { version: "1.1.0" },
        { packages: lock.packages },
        { packages: pkgs },
      );
      expect(result?.status).toBe("skip");
      expect(result?.data?.missingVersions).toEqual([
        "package-lock.json",
        "node_modules/.package-lock.json",
      ]);
    });

    it("says WHICH file is missing its version", () => {
      const result = evaluateNpmStaleness({}, lock, hidden);
      expect(result?.message).toContain("package.json");
      expect(result?.message).toContain("version");
    });

    it("the version guard still fires when the versions ARE comparable", () => {
      // The control: the release-cut slip this guard exists to catch.
      const result = evaluateNpmStaleness({ version: "1.1.0" }, lock, hidden);
      expect(result).toMatchObject({ status: "warn" });
      expect(result?.message).toContain("out of date");
    });

    it("package drift still WARNS even when a version is missing", () => {
      // The version guard gates only the final green — it must not swallow a
      // real packages finding on its way past.
      const drifted = { version: "1.0.0", packages: { "node_modules/foo": { version: "9.9.9" } } };
      const result = evaluateNpmStaleness({}, lock, drifted);
      expect(result).toMatchObject({ status: "warn" });
      expect(result?.data?.driftCount).toBe(1);
    });
  });

  // ── Finding 3: a malformed entry took down the WHOLE report ──
  describe("malformed input is rejected at the boundary, not cast past it", () => {
    it("does not throw on a null packages entry", () => {
      // Was: TypeError: Cannot read properties of null (reading 'optional'),
      // thrown out of the 'pure' function and up through runDoctor.
      const lock = { version: "1.0.0", packages: { "node_modules/x": null } };
      expect(() => evaluateNpmStaleness(pkg, lock, freshHidden)).not.toThrow();
      const result = evaluateNpmStaleness(pkg, lock, freshHidden);
      expect(result?.status).toBe("skip");
      expect(result?.data?.reason).toBe("malformed-lock");
    });

    it("does not throw on a null entry in the HIDDEN lockfile", () => {
      const hidden = { version: "1.0.0", packages: { "node_modules/foo": null } };
      expect(() => evaluateNpmStaleness(pkg, freshLock, hidden)).not.toThrow();
      expect(evaluateNpmStaleness(pkg, freshLock, hidden)?.data?.reason).toBe(
        "malformed-hidden-lock",
      );
    });

    it.each([
      ["a string", "not-a-lockfile"],
      ["an array", []],
      ["a number", 42],
      ["packages as an array", { version: "1.0.0", packages: [] }],
      ["a non-string version", { version: 3, packages: { "node_modules/x": {} } }],
      ["an entry with a non-string version", { packages: { "node_modules/x": { version: 1 } } }],
    ])("skips rather than throwing when the lockfile is %s", (_label, lock) => {
      expect(() => evaluateNpmStaleness(pkg, lock, freshHidden)).not.toThrow();
      expect(evaluateNpmStaleness(pkg, lock, freshHidden)?.status).toBe("skip");
    });

    it("does not leak a parse snippet or path into the skip message", () => {
      const lock = { version: "1.0.0", packages: { "node_modules/x": null } };
      const result = evaluateNpmStaleness(pkg, lock, freshHidden);
      expect(result?.message).not.toContain("node_modules/x");
    });
  });

  // ── Finding 9: every skip must SAY it skipped and why ──
  describe("skips announce themselves", () => {
    it.each([
      ["v1 lockfile", { version: "1.0.0" }, { version: "1.0.0" }],
      ["malformed lock", { packages: { a: null } }, { version: "1.0.0", packages: {} }],
    ])("%s carries a human-readable reason", (_label, lock, hidden) => {
      const result = evaluateNpmStaleness(pkg, lock, hidden);
      expect(result?.status).toBe("skip");
      expect(result?.message.length).toBeGreaterThan(0);
      expect(result?.data?.reason).toBeTruthy();
    });
  });
});

describe("evaluateOrphanedVite", () => {
  const ports = { wsPort: 3478, mcpPort: 3479, vitePort: 5173 };

  it("reports nothing when no Vite server is listening", () => {
    expect(
      evaluateOrphanedVite({
        viteUp: false,
        viteConfirmed: false,
        wsUp: false,
        mcpUp: false,
        ...ports,
      }),
    ).toBeNull();
    expect(
      evaluateOrphanedVite({
        viteUp: false,
        viteConfirmed: false,
        wsUp: true,
        mcpUp: true,
        ...ports,
      }),
    ).toBeNull();
  });

  it("warns with a kill + restart fix when Vite is up but both backend ports are down", () => {
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: true,
      wsUp: false,
      mcpUp: false,
      ...ports,
    });
    expect(result).toMatchObject({ status: "warn" });
    expect(result?.message).toContain("5173");
    expect(result?.message).toContain("3478");
    expect(result?.message).toContain("3479");
    expect(result?.fix).toContain("kill");
    expect(result?.fix).toContain("npm run dev:standalone");
  });

  it("names dev:client in the fix — running the client alone is a documented script", () => {
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: true,
      wsUp: false,
      mcpUp: false,
      ...ports,
    });
    expect(result?.fix).toContain("dev:client");
  });

  it("passes when Vite and the backend are both up", () => {
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: true,
      wsUp: true,
      mcpUp: true,
      ...ports,
    });
    expect(result).toMatchObject({ status: "pass" });
  });

  // ── Finding 7: identity a TCP probe cannot support ──
  it("skips rather than naming Vite when /@vite/client did not confirm", () => {
    // Something holds :5173 and the backend is down — the exact shape of the
    // orphan warn — but we never confirmed it is Vite. Must not warn, must
    // not tell the user to kill an unidentified process.
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: false,
      wsUp: false,
      mcpUp: false,
      ...ports,
    });
    expect(result?.status).toBe("skip");
    expect(result?.message).toContain("/@vite/client");
    expect(result?.fix).toBeUndefined();
  });

  it("does not claim Vite is 'running alongside the backend' when unconfirmed", () => {
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: false,
      wsUp: true,
      mcpUp: true,
      ...ports,
    });
    expect(result?.status).toBe("skip");
  });

  // ── Finding 8: partial backend emitted a false green ──
  it("skips (does NOT pass) while the backend is only partially up", () => {
    // Half a backend is not "running alongside the backend" — the ports check
    // warns about that, and this check must not contradict it with a green.
    for (const [wsUp, mcpUp] of [
      [true, false],
      [false, true],
    ] as const) {
      const result = evaluateOrphanedVite({
        viteUp: true,
        viteConfirmed: true,
        wsUp,
        mcpUp,
        ...ports,
      });
      expect(result?.status).toBe("skip");
      expect(result?.message).toContain("partially up");
      expect(result?.data?.reason).toBe("partial-backend");
    }
  });

  it("reports the probed vitePort, not a hardcoded 5173", () => {
    const result = evaluateOrphanedVite({
      viteUp: true,
      viteConfirmed: true,
      wsUp: false,
      mcpUp: false,
      wsPort: 3478,
      mcpPort: 3479,
      vitePort: 6100,
    });
    expect(result?.message).toContain("6100");
    expect(result?.message).not.toContain("5173");
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

  /**
   * Seed a minimal checkout with a COMPLETE, CONSISTENT lockfile trio.
   *
   * The trio must contain a real `node_modules/*` entry on both sides. The
   * original seed wrote `lock.packages = {"":{...}}` / `hidden.packages = {}`,
   * which compares NOTHING (the drift loop skips the root entry) — so the
   * "passes with a fresh install" test was ratifying the very false-PASS bug
   * this branch is fixing, and the gate test below skipped for an unrelated
   * reason. `name` is a parameter so the same complete seed can stand up a
   * non-tandem cwd: that is what makes the gate test fail when the gate goes.
   *
   * Not marked `dev: true` on purpose — dev entries are NOT exempt from drift
   * (409 of 795 real non-root entries are dev; exempting them would silently
   * stop reporting a missing vitest/biome, the most common real drift).
   */
  function seedRepo(versions: {
    pkg: string;
    lock: string;
    hidden: string;
    name?: string;
    installed?: string;
  }): void {
    const name = versions.name ?? "tandem-editor";
    const installed = versions.installed ?? "2.3.4";
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name, version: versions.pkg }));
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({
        name,
        version: versions.lock,
        lockfileVersion: 3,
        packages: {
          "": { version: versions.lock },
          "node_modules/foo": { version: "2.3.4" },
        },
      }),
    );
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".package-lock.json"),
      JSON.stringify({
        name,
        version: versions.hidden,
        lockfileVersion: 3,
        packages: { "node_modules/foo": { version: installed } },
      }),
    );
  }

  it("skips both gated checks silently in a non-tandem cwd (global-install user)", async () => {
    // An end-user cwd with their OWN project's package.json — the exact case
    // the gate exists for: no warn, no fail, no mention at all.
    //
    // Seeded with a COMPLETE, CONSISTENT lockfile trio and a live Vite
    // listener, so both gated checks would produce a result here if the gate
    // were removed. Without that, this test passed with `if (devRepo)`
    // deleted — the checks skipped for unrelated reasons (no lockfiles,
    // nothing on the Vite port) and the gate was never actually exercised.
    seedRepo({ pkg: "9.9.9", lock: "9.9.9", hidden: "9.9.9", name: "someones-app" });
    mockCwd(repoDir);

    await using vite = await fakeViteServer();

    const report = await runDoctor({ vitePort: vite.port });
    const names = report.results.map((res) => res.check);
    expect(names).not.toContain("npm-staleness");
    expect(names).not.toContain("orphaned-vite");
  });

  it("reports npm-staleness in a tandem cwd with the SAME seed — proving the gate is what silences it", async () => {
    // The positive control for the test above. Identical seed, only `name`
    // differs, so the sole reason the checks disappear up there is the gate.
    seedRepo({ pkg: "9.9.9", lock: "9.9.9", hidden: "9.9.9", name: "tandem-editor" });
    mockCwd(repoDir);

    await using vite = await fakeViteServer();

    const report = await runDoctor({ vitePort: vite.port });
    const names = report.results.map((res) => res.check);
    expect(names).toContain("npm-staleness");
    expect(names).toContain("orphaned-vite");
  });

  // ── Finding 6 (gated): the tri-state warn ──
  it("warns dev-repo when package.json exists but cannot be read", async () => {
    writeFileSync(join(repoDir, "package.json"), "{ not json");
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "dev-repo");
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("could not be read");
  });

  it("stays silent about dev-repo in an ordinary end-user cwd", async () => {
    // The false-warn this must never become: an end user with no package.json
    // at all, or someone else's, hears nothing about "the repo".
    mockCwd(repoDir);
    expect((await runDoctor()).results.map((r) => r.check)).not.toContain("dev-repo");

    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "someones-app" }));
    expect((await runDoctor()).results.map((r) => r.check)).not.toContain("dev-repo");
  });

  // ── node_modules is a finding only inside the checkout (#1404 sibling) ──
  //
  // Why this matters, and why the remedy is the harmful half rather than the
  // FAIL: see `checkNodeModules`'s header in src/cli/doctor.ts.
  it("skips node-modules outside the checkout, with no npm install remedy", async () => {
    // No node_modules here, which is exactly what used to produce the FAIL.
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "someones-app" }));
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "node-modules");
    // Still REPORTED, not silently gated away — a `--json` consumer that has
    // always seen this key must not have it vanish.
    expect(result).toBeDefined();
    expect(result?.status).toBe("pass");
    expect(result?.data).toMatchObject({ skipped: true });
    // `fix` is dropped by the human renderer on a pass, so guidance that lands
    // there reaches --json and nobody else. It must not be set at all.
    expect(result?.fix).toBeUndefined();
    expect(result?.message).not.toContain("npm install");
  });

  it("skips node-modules outside the checkout even when node_modules IS present", async () => {
    // The positive half: the gate is the repo probe, not the directory
    // listing. A user whose own project happens to have node_modules must not
    // get a green line claiming Tandem checked something.
    seedRepo({ pkg: "9.9.9", lock: "9.9.9", hidden: "9.9.9", name: "someones-app" });
    mockCwd(repoDir);

    const result = (await runDoctor()).results.find((res) => res.check === "node-modules");
    expect(result?.data).toMatchObject({ skipped: true, reason: "not-checkout" });
  });

  it("still FAILs node-modules inside the checkout — the fix must not neuter the real case", async () => {
    // Tandem checkout, no node_modules: a genuine failure with a remedy that
    // genuinely works. If this ever goes green the fix has gone too far.
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "tandem-editor" }));
    mockCwd(repoDir);

    const result = (await runDoctor()).results.find((res) => res.check === "node-modules");
    expect(result?.status).toBe("fail");
    expect(result?.fix).toBe("npm install");
  });

  it("does not claim 'not the checkout' when package.json is unreadable", async () => {
    // `devRepo` collapses "no" and "unreadable", so a boolean gate would print
    // "this is not the tandem-editor checkout" immediately above the dev-repo
    // warning that says it might be — two adjacent lines contradicting each
    // other, with the pass as the false half.
    writeFileSync(join(repoDir, "package.json"), "{ not json");
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "node-modules");
    // Assert on `reason`, not prose — the message is free to be reworded.
    expect(result?.data).toMatchObject({ skipped: true, reason: "package-json-unreadable" });
    expect(result?.message).not.toContain("is not the tandem-editor checkout");
    // And the warning it must not contradict is genuinely there.
    expect(report.results.find((res) => res.check === "dev-repo")?.status).toBe("warn");
  });

  // ── Finding 5: absent vs broken lockfiles ──
  it("skips npm-staleness with a reason when the hidden lockfile is absent (fresh clone)", async () => {
    // Fresh clone before `npm install`: must SAY it skipped, must NOT warn.
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({ version: "0.2.0", lockfileVersion: 3, packages: {} }),
    );
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("skipped");
    expect(result?.message).toContain("not found");
    expect(result?.data?.skipped).toBe(true);
  });

  it("warns (naming the file) when package-lock.json is present but broken", async () => {
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    // A merge-conflicted lockfile — one of the two findings this check exists
    // for, and one it used to silently swallow as "absent".
    writeFileSync(join(repoDir, "package-lock.json"), "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n");
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("package-lock.json");
    expect(result?.message).toContain("not valid JSON");
  });

  it.each([
    ["the JSON literal null", "null"],
    ["a JSON number", "0"],
    ["a JSON array", "[]"],
  ])("never skips SILENTLY when package-lock.json is %s", async (_label, content) => {
    // Parseable JSON, but not a lockfile. The falsy cases are the trap: a
    // `unknown | null` return cannot distinguish "nothing to report" from a
    // file whose content IS null, so this used to bail having recorded
    // nothing at all — a silent skip, the one thing this check must not do.
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    writeFileSync(join(repoDir, "package-lock.json"), content);
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result).toBeDefined();
    expect(result?.message).toContain("package-lock.json");
  });

  it("does not echo a parse snippet into the warn (doctor output is pasted publicly)", async () => {
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    writeFileSync(join(repoDir, "package-lock.json"), '{ "authToken": "sk-secret-do-not-leak" ');
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(JSON.stringify(result)).not.toContain("sk-secret-do-not-leak");
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
    // An EARNED pass — not a skip wearing the pass wire status.
    expect(result?.data?.skipped).toBeUndefined();
    expect(result?.message).not.toContain("skipped");
  });

  it("warns npm-staleness when an installed package drifts from the lockfile", async () => {
    // End-to-end through the real file reads, not just the pure function.
    seedRepo({ pkg: "0.2.0", lock: "0.2.0", hidden: "0.2.0", installed: "9.9.9" });
    mockCwd(repoDir);

    const report = await runDoctor();
    const result = report.results.find((res) => res.check === "npm-staleness");
    expect(result?.status).toBe("warn");
    expect(result?.data?.driftCount).toBe(1);
  });
});

// ── Finding 11: orphaned-vite had ZERO integration coverage ──
describe("orphaned-vite integration", () => {
  let repoDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tandem-vite-"));
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "tandem-editor", version: "0.2.0" }),
    );
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoDir);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("warns about an orphan when a real Vite server outlives a dead backend", async () => {
    await using vite = await fakeViteServer();
    // Two ports nobody is listening on = the backend is down.
    const wsPort = await allocPort();
    const mcpPort = await allocPort();

    const report = await runDoctor({ wsPort, mcpPort, vitePort: vite.port });
    const result = report.results.find((res) => res.check === "orphaned-vite");
    expect(result?.status).toBe("warn");
    // Ports must be reported against the right service. Transposing the
    // wsPort/mcpPort arguments at the call site left the suite green before
    // this assertion existed.
    expect(result?.message).toContain(String(vite.port));
    expect(result?.message).toContain(`:${wsPort} + :${mcpPort}`);
  });

  it("does not name Vite when the listener on the port is not a Vite server", async () => {
    // A TCP connect proves only that something holds the port. This is the
    // end-user-shaped case: some other dev server on the same port.
    await using notVite = await fakeViteServer({ serveViteClient: false });
    const wsPort = await allocPort();
    const mcpPort = await allocPort();

    const report = await runDoctor({ wsPort, mcpPort, vitePort: notVite.port });
    const result = report.results.find((res) => res.check === "orphaned-vite");
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("skipped");
    expect(result?.data?.reason).toBe("unconfirmed-vite");
    // Critically: no instruction to kill a process we could not identify.
    expect(result?.fix).toBeUndefined();
  });

  it("reports nothing at all when the Vite port is free", async () => {
    const freePort = await allocPort();
    const report = await runDoctor({ vitePort: freePort });
    expect(report.results.map((res) => res.check)).not.toContain("orphaned-vite");
  });
});

// ── evaluatePushPath ────────────────────────────────────────────────────────
//
// The PUSH path is a different connection from the pull path `hasSession`
// reports, and conflating them is how a user ends up staring at "AI connected"
// while nothing they do reaches Claude. These branches are the user-facing
// output of that distinction, and none of them were covered.

describe("evaluateAbsentChannelEntry", () => {
  // The renderer prints `fix` only when `status !== "pass"`. This check is a
  // PASS, so everything a user is meant to act on has to be in the message —
  // the first version returned a `{message, fix}` pair and its advice went to
  // `--json` and nobody else. Assert on the one string, which is also all the
  // call sites now pass.
  it("carries its guidance in the message, where a pass line is actually printed", () => {
    const msg = evaluateAbsentChannelEntry("~/.claude.json");
    expect(msg).toMatch(/--with-channel-shim/);
    expect(msg).toMatch(/watch/i);
  });

  it("does not send the reader to a command that no longer writes the entry", () => {
    // `tandem setup --apply` alone stopped writing this entry in Track E, so
    // the old remedy changed nothing and read as "your config is broken".
    const msg = evaluateAbsentChannelEntry("~/.claude.json");
    expect(msg).not.toMatch(/setup --apply(?! --with-channel-shim)/);
  });

  it("does not promise the watch outright — it has a host precondition", () => {
    // The `Monitor` tool is behind the remote `tengu_amber_sentinel` gate, so
    // "nothing to install" holds only where the host offers the tool. This line
    // read as an unconditional promise until 2026-08-09. Matching bare /Monitor/
    // rather than /Monitor tool/ on purpose: the capitalised word is the tool's
    // literal name and appears exactly once, so it has the same power to catch a
    // deleted caveat while surviving a reword to "a Monitor capability".
    expect(evaluateAbsentChannelEntry("~/.claude.json")).toMatch(/Monitor/);
  });

  it("points a Monitor-less reader at the shim, the one option that does not need it", () => {
    // Both headline options here read the same remote gate, so a reader without
    // the tool has neither — only the shim, which this line demotes to an aside.
    // Without this, the pass line lists two remedies that can fail together and
    // buries the one that cannot.
    const msg = evaluateAbsentChannelEntry("~/.claude.json");
    expect(msg).toMatch(/shim does not/);
  });

  it("says absence is expected rather than broken, and carries the caller's label", () => {
    expect(evaluateAbsentChannelEntry(".mcp.json")).toMatch(/^\.mcp\.json /);
    expect(evaluateAbsentChannelEntry("~/.claude.json")).toMatch(/^~\/\.claude\.json /);
    expect(evaluateAbsentChannelEntry(".mcp.json")).toMatch(/expected/i);
  });
});

describe("evaluatePushPath", () => {
  it("skips with an explanation when the server reports no push field", () => {
    // Silence would read as a passing check — the troubleshooting entry tells
    // the reader to look for this line.
    for (const absent of [undefined, null, "nope", 42]) {
      const out = evaluatePushPath(absent);
      expect(out?.status).toBe("skip");
      expect(out?.message).toMatch(/older/i);
    }
  });

  it("warns when nothing is attached, and names all three remedies", () => {
    const out = evaluatePushPath({ subscribers: 0, eventCount: 0, lastEventAt: null });
    expect(out?.status).toBe("warn");
    expect(out?.message).toMatch(/not notified/i);
    // All three transports, because `subscribers: 0` cannot say which one is
    // missing. The self-armed watch leads: it is the only one of the three that
    // needs neither an install nor a flag (ADR-049).
    expect(out?.fix).toMatch(/arm a watch/i);
    expect(out?.fix).toMatch(/plugin/i);
    expect(out?.fix).toMatch(/dangerously-load-development-channels/);
    // The shim is opt-in since Track E, so the remedy must say how to register
    // it — naming only the launch flag would send the reader to a flag with no
    // server entry behind it.
    expect(out?.fix).toMatch(/--with-channel-shim/);
    expect(out?.fix).toMatch(/choose one setup route where possible/i);
    expect(out?.fix).toMatch(/plugin[^.]*built-in Monitor[^.]*both automatically/i);
    expect(out?.fix).toMatch(/TaskStop/);
    expect(out?.data).toMatchObject({ subscribers: 0, eventCount: 0 });
  });

  it("qualifies the leading remedy and always names the Monitor-free fallback", () => {
    // The watch leads because it needs no install, but it needs a `Monitor`
    // tool. The shim is the only remedy that avoids every Monitor precondition;
    // the plugin shares the account gate but not the Windows Git Bash one.
    //
    // Asserted as "the sentence naming Monitor also redirects", so a reword of
    // either clause survives while deleting either one fails.
    const out = evaluatePushPath({ subscribers: 0, eventCount: 0, lastEventAt: null });
    expect(out?.fix).toMatch(/Monitor/);

    // Anchored on the sentence that fires when the tool is missing, not on the
    // whole string: "shim" appears further down regardless, as one of the three
    // remedies, so a whole-string match would pass even with the redirect gone.
    const redirect = out?.fix?.split(/(?<=\.)\s+/).find((s) => /has none/i.test(s));
    expect(redirect, "nothing tells the reader what to do when the tool is absent").toBeDefined();
    expect(redirect).toMatch(/shim/i);
    expect(out?.fix, "must warn that the plugin shares the account gate").toMatch(
      /plugin monitor shares (?:that|the) per-account (?:feature )?gate/i,
    );
    // And it must not send them to the path behind the same gate.
    expect(out?.fix).not.toMatch(/use one of the others/i);
  });

  it("does not blame the Claude Code version for a per-account feature", () => {
    // `tengu_amber_sentinel` is a remote gate: two users on byte-identical builds
    // differ. "not every Claude Code build exposes it" — the wording this fix
    // shipped with for a few hours — sends the reader hunting for an upgrade
    // that cannot help, and README's neighbouring plugin advice IS a real
    // version requirement, which makes the misread easy.
    const out = evaluatePushPath({ subscribers: 0, eventCount: 0, lastEventAt: null });
    expect(out?.fix).not.toMatch(/Claude Code build/i);
    expect(out?.fix).toMatch(/per account/i);
  });

  it("distinguishes the shared account gate from the Monitor-only Git Bash requirement", () => {
    const out = evaluatePushPath({ subscribers: 0, eventCount: 0, lastEventAt: null });

    expect(out?.fix).toMatch(/on Windows it also needs Git Bash/i);
    expect(out?.fix).toMatch(/plugin monitor shares (?:that|the) per-account (?:feature )?gate/i);
    expect(out?.fix).toMatch(/plugin monitor does not require Git Bash on Windows/i);
    expect(out?.fix).toMatch(/PowerShell/i);
  });

  it("passes without alarm when attached but nothing delivered yet", () => {
    const out = evaluatePushPath({ subscribers: 2, eventCount: 0, lastEventAt: null });
    expect(out?.status).toBe("pass");
    // Expected in Solo (the Solo filter sits above the heartbeat) and before any
    // edit — must not read as a fault.
    expect(out?.message).toMatch(/Solo/);
    expect(out?.message).toMatch(/NOT that this Claude session is covered/);
    expect(out?.data).toMatchObject({ subscribers: 2, eventCount: 0 });
  });

  it("reports elapsed time without claiming Claude saw anything", () => {
    const out = evaluatePushPath({
      subscribers: 1,
      eventCount: 7,
      lastEventAt: Date.now() - 41_000,
    });
    expect(out?.status).toBe("pass");
    expect(out?.message).toMatch(/4[01]s ago/);
    // The load-bearing disclaimer: an attached consumer may be inert.
    expect(out?.message).toMatch(/NOT that this Claude session is covered/);
    expect(out?.message).toMatch(/or saw them/);
  });

  it("tolerates a malformed push object rather than throwing", () => {
    const out = evaluatePushPath({ subscribers: "three", eventCount: null });
    expect(out?.status).toBe("warn"); // unparseable count falls back to 0 = nothing attached
    expect(out?.data).toMatchObject({ subscribers: 0, eventCount: 0 });
  });
});

/**
 * The Tandem plugin check.
 *
 * Two live field hazards, both reported by the same macOS tester: the plugin's
 * monitor exits 127 when Node is not on the PATH the client inherits, and the
 * plugin's MCP servers duplicate the ones setup writes. Nothing in a published
 * static manifest can fix either, so naming them is the whole remedy available.
 *
 * The tester saw the 127 in EVERY session, which is what made it a field
 * report rather than a footnote; #1354 narrowed that to sessions that actually
 * dispatched the Tandem skill (`on-skill-invoke` replaced `when: "always"`).
 * The check itself is unchanged — in an armed session it still fails every
 * time — but do not re-derive "every session" from this docblock.
 */
describe("evaluateTandemPlugin", () => {
  it("says nothing when settings could not be read", () => {
    // Absence is not evidence. A missing or malformed settings file must not
    // be reported as "no plugin".
    expect(evaluateTandemPlugin({ enabledPlugins: null, wizardTandemEntry: true })).toEqual([]);
  });

  it("says nothing when no Tandem plugin is enabled", () => {
    expect(
      evaluateTandemPlugin({
        enabledPlugins: { "other@market": true },
        wizardTandemEntry: true,
      }),
    ).toEqual([]);
  });

  it("does NOT report a deliberately disabled plugin as installed", () => {
    // `false` is common — 20 of 31 entries on the dev machine this was written
    // on. A truthiness check here would nag a user who already opted out.
    expect(
      evaluateTandemPlugin({
        enabledPlugins: { "tandem@tandem-editor": false },
        wizardTandemEntry: true,
      }),
    ).toEqual([]);
  });

  it("notes the npx dependency when the plugin is enabled, without warning", () => {
    const out = evaluateTandemPlugin({
      enabledPlugins: { "tandem@tandem-editor": true },
      wizardTandemEntry: false,
    });
    expect(out).toHaveLength(1);
    // `pass`, not `warn`. Registry presence is not evidence the monitor failed
    // — with Node on PATH it starts fine — and `printPushStatus` actively
    // recommends installing this plugin. A permanent warning for following our
    // own advice is a report the user can never clean, so the mechanism lives
    // in `fix` while the status stays honest about what we observed.
    expect(out[0].status).toBe("pass");
    expect(out[0].message).toContain("npx");
    expect(out[0].fix).toContain("exit 127");
    // Names the actual mechanism, not just the symptom.
    expect(out[0].fix).toContain("non-login shell");
    // And the arming precondition (#1354) — a user who never asks for Tandem
    // by name sees no monitor at all, which reads as a broken install unless
    // the fix text says so. This sentence had no coverage of any kind.
    expect(out[0].fix).toContain("Tandem skill");
  });

  it("adds the duplication warning only when a wizard entry also exists", () => {
    const both = evaluateTandemPlugin({
      enabledPlugins: { "tandem@tandem-editor": true },
      wizardTandemEntry: true,
    });
    expect(both).toHaveLength(2);
    expect(both[1].message).toContain("twice");

    // A plugin-only user has nothing duplicated — one warning, not two.
    const pluginOnly = evaluateTandemPlugin({
      enabledPlugins: { "tandem@tandem-editor": true },
      wizardTandemEntry: false,
    });
    expect(pluginOnly).toHaveLength(1);
  });

  it("matches any marketplace the plugin was installed from", () => {
    // The install identity is `tandem@<marketplace>`, and a locally-registered
    // marketplace would carry a different name than the published one.
    const out = evaluateTandemPlugin({
      enabledPlugins: { "tandem@some-local-marketplace": true },
      wizardTandemEntry: false,
    });
    expect(out).toHaveLength(1);
  });

  it("names the marketplace it actually found in the uninstall command", () => {
    // Detection is marketplace-agnostic but the remedy used to hardcode
    // `tandem@tandem-editor`, so a user who registered a local marketplace —
    // the no-git path `docs/spikes/plugin-delivery.md` recommends — was handed
    // a command that errors. Both outcomes carry an uninstall string.
    const out = evaluateTandemPlugin({
      enabledPlugins: { "tandem@some-local-marketplace": true },
      wizardTandemEntry: true,
    });
    expect(out).toHaveLength(2);
    for (const outcome of out) {
      expect(outcome.fix).toContain("claude plugin uninstall tandem@some-local-marketplace");
      expect(outcome.fix).not.toContain("tandem@tandem-editor");
    }
  });
});

/**
 * The two checks that exist because a beta tester's client could not spawn
 * `npx` and `tandem doctor` had nothing to say about it.
 *
 * Both are deliberately separate from the staleness probe, which returns early
 * on a bare command by design — so before these, the most common broken shape
 * was the one shape no check examined.
 */
describe("evaluateSpawnedEntryCommand", () => {
  it("warns on a bare command, naming the symptom the user actually sees", () => {
    const outcome = evaluateSpawnedEntryCommand(
      { command: "npx", args: ["-y", "tandem-editor@0.21.0", "mcp-stdio"] },
      "tandem",
      "Claude Desktop config",
    );
    expect(outcome?.status).toBe("warn");
    expect(outcome?.message).toContain("npx");
    expect(outcome?.message).toContain("Claude Desktop config");
    // The remedy has to cover BOTH surfaces: the entry Tandem manages (fixable
    // by re-running setup) and the plugin/Cowork ones (not fixable at all).
    expect(outcome?.fix).toContain("tandem setup --apply");
    expect(outcome?.fix).toMatch(/plugin|Cowork/);
  });

  it("stays silent on an absolute command (that is the staleness probe's job)", () => {
    expect(
      evaluateSpawnedEntryCommand(
        { command: "/opt/homebrew/bin/node", args: ["/opt/t/dist/stdio-bridge/index.js"] },
        "tandem",
        "Claude Desktop config",
      ),
    ).toBeNull();
  });

  it("stays silent on an HTTP entry, which spawns nothing", () => {
    expect(
      evaluateSpawnedEntryCommand(
        { type: "http", url: "http://127.0.0.1:3479/mcp" },
        "tandem",
        "~/.claude.json",
      ),
    ).toBeNull();
    expect(evaluateSpawnedEntryCommand(null, "tandem", "~/.claude.json")).toBeNull();
  });

  it("never echoes the entry's env, which carries the bearer token", () => {
    const outcome = evaluateSpawnedEntryCommand(
      {
        command: "npx",
        args: ["-y", "tandem-editor@0.21.0", "mcp-stdio"],
        env: { TANDEM_AUTH_TOKEN: "supersecrettokenvalue0123456789ab" },
      },
      "tandem",
      "Claude Desktop config",
    );
    // Doctor output reaches /api/diagnostics and the Copy Diagnostics
    // clipboard, i.e. public issues.
    const rendered = `${outcome?.message} ${outcome?.fix}`;
    expect(rendered).not.toContain("supersecrettokenvalue0123456789ab");
    expect(rendered).not.toContain("TANDEM_AUTH_TOKEN");
  });
});

describe("evaluateNodeToolchain", () => {
  it("passes WITH the caveat when both resolve — a green tick alone would mislead", () => {
    const outcome = evaluateNodeToolchain({ node: true, npx: true });
    expect(outcome.status).toBe("pass");
    // This is the whole point: doctor reads the PATH of the shell it was
    // launched from, which is not the PATH a GUI-launched client inherits. The
    // tester would have run doctor, seen green, and learned nothing.
    expect(outcome.message).toMatch(/GUI-launched/);
    expect(outcome.message).toMatch(/narrower/);
  });

  it.each([
    [{ node: false, npx: true }, "node"],
    [{ node: true, npx: false }, "npx"],
  ])("warns when %o is missing", (present, expected) => {
    const outcome = evaluateNodeToolchain(present);
    expect(outcome.status).toBe("warn");
    expect(outcome.message).toContain(expected);
  });

  it("names both when neither resolves", () => {
    const outcome = evaluateNodeToolchain({ node: false, npx: false });
    expect(outcome.status).toBe("warn");
    expect(outcome.message).toContain("node and npx");
    expect(outcome.fix).toBeDefined();
  });

  it("never enumerates PATH directories in its output", () => {
    // Same enum-only posture as GET /api/integrations/claude-cli-status (F6):
    // this report is LAN-reachable and must not leak the user's home layout.
    for (const present of [
      { node: true, npx: true },
      { node: false, npx: false },
    ]) {
      const outcome = evaluateNodeToolchain(present);
      expect(`${outcome.message} ${outcome.fix ?? ""}`).not.toContain("/usr/bin");
    }
  });
});
