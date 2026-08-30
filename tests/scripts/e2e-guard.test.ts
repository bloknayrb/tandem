import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertServedClientTargetsHarness,
  fetchServedBackendPortsModule,
  foreignServerMessage,
  isContainedIn,
  isE2EStoragePath,
  probeForeignServer,
  runGuard,
} from "../../scripts/e2e-guard";
import { E2E_APP_DATA_DIR } from "../../scripts/e2e-paths";
import { E2E_MCP_PORT, E2E_WS_PORT } from "../../scripts/test-ports";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants";

/**
 * #1483. The failure this guards is destructive and is deliberately never
 * reproduced end to end — reproducing it means running the E2E suite against
 * real documents — so the decisions it rests on are tested directly instead:
 * the containment predicate, and the probe that classifies a live answer.
 */
describe("isContainedIn — platform flavours", () => {
  // The seam exists for these four. `path.win32.relative` across DRIVES returns
  // an absolute path, so `startsWith("..")` is false and `!isAbsolute(rel)` is
  // the ONLY clause rejecting it. On posix that clause is unreachable, so
  // without explicitly passing `path.win32` the load-bearing half is untested
  // on the platform CI actually runs.
  it("rejects a different Windows drive, which startsWith('..') does not catch", () => {
    const rel = path.win32.relative("C:\\tmp\\tandem-e2e-data", "D:\\tmp\\tandem-e2e-data\\x");
    expect(rel.startsWith("..")).toBe(false); // pins WHY the isAbsolute clause is needed
    expect(path.win32.isAbsolute(rel)).toBe(true);
    expect(
      isContainedIn("C:\\tmp\\tandem-e2e-data", "D:\\tmp\\tandem-e2e-data\\x", path.win32),
    ).toBe(false);
  });

  it("accepts a descendant under win32 semantics", () => {
    expect(
      isContainedIn("C:\\tmp\\tandem-e2e-data", "C:\\tmp\\tandem-e2e-data\\sessions", path.win32),
    ).toBe(true);
  });

  it("accepts a descendant under posix semantics", () => {
    expect(isContainedIn("/tmp/tandem-e2e-data", "/tmp/tandem-e2e-data/sessions", path.posix)).toBe(
      true,
    );
  });

  it("rejects a sibling sharing a prefix under both flavours", () => {
    expect(
      isContainedIn("C:\\tmp\\tandem-e2e-data", "C:\\tmp\\tandem-e2e-data-real\\s", path.win32),
    ).toBe(false);
    expect(isContainedIn("/tmp/tandem-e2e-data", "/tmp/tandem-e2e-data-real/s", path.posix)).toBe(
      false,
    );
  });
});

describe("isE2EStoragePath", () => {
  it("accepts the sessions subdirectory the server actually reports", () => {
    // `/api/info` reports SESSION_DIR = path.join(APP_DATA_DIR, "sessions"),
    // never the app-data root itself. An equality check would reject our own
    // server and fail every run — this is the case that pins that.
    expect(isE2EStoragePath(path.join(E2E_APP_DATA_DIR, "sessions"))).toBe(true);
  });

  it("accepts the app-data root itself", () => {
    expect(isE2EStoragePath(E2E_APP_DATA_DIR)).toBe(true);
  });

  it("accepts a deeper descendant", () => {
    expect(isE2EStoragePath(path.join(E2E_APP_DATA_DIR, "annotations", "x"))).toBe(true);
  });

  it("rejects a real user app-data path", () => {
    const real =
      process.platform === "win32"
        ? "C:\\Users\\someone\\AppData\\Local\\tandem\\sessions"
        : "/home/someone/.local/share/tandem/sessions";
    expect(isE2EStoragePath(real)).toBe(false);
  });

  it("rejects a sibling whose name merely starts with the E2E dir", () => {
    // Guards against a `startsWith` implementation: `/tmp/tandem-e2e-data-real`
    // shares a prefix with `/tmp/tandem-e2e-data` but is a different directory.
    expect(isE2EStoragePath(`${E2E_APP_DATA_DIR}-real/sessions`)).toBe(false);
  });

  it("rejects a path that escapes upward", () => {
    expect(isE2EStoragePath(path.join(E2E_APP_DATA_DIR, "..", "elsewhere"))).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1234],
    ["an empty string", ""],
  ])("rejects %s — fail closed, an unidentifiable answer is foreign", (_label, value) => {
    expect(isE2EStoragePath(value)).toBe(false);
  });
});

/**
 * The probe is where the fail-closed rule is actually implemented, and where it
 * was once inverted: `res.json()` shared a `try` with `fetch`, so an unparseable
 * body and a slow one both returned "clear" and let the destructive suite run.
 * Every row below distinguishes "nothing accepted the connection" (the one safe
 * clear) from "something did, and we could not identify it" (refuse).
 */
describe("probeForeignServer — only a refused connection is clear", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** Start a stub on an ephemeral port and return it. */
  async function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  const json = (body: unknown): http.RequestListener => {
    return (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
  };

  it("clears a server reporting an E2E storage path", async () => {
    const port = await serve(json({ storagePath: path.join(E2E_APP_DATA_DIR, "sessions") }));
    expect(await probeForeignServer(port)).toBeNull();
  });

  it("refuses a server reporting a real user path", async () => {
    const port = await serve(json({ storagePath: "/home/someone/.local/share/tandem/sessions" }));
    expect(await probeForeignServer(port)).toBe("/home/someone/.local/share/tandem/sessions");
  });

  it("refuses a 200 whose body is not JSON", async () => {
    // A proxy, a stale build, any dev tool answering /api/info with HTML.
    const port = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not tandem</html>");
    });
    expect(await probeForeignServer(port)).toMatch(/^\(bound, but \/api\/info body unreadable:/);
  });

  it("refuses a 200 whose body never arrives — the timeout is NOT a clear", async () => {
    // The dangerous row. A busy desktop sidecar that answers headers and then
    // stalls used to share a catch with the connection error and read as clear.
    // Note it surfaces from the BODY read, not from `fetch` — an abort
    // mid-stream throws there — so both catches must refuse, not just one.
    const port = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"storagePath":');
      // deliberately never ended
    });
    const verdict = await probeForeignServer(port, 250);
    expect(verdict).not.toBeNull();
    expect(verdict).toMatch(/timeout/i);
  });

  it.each([404, 500])("refuses HTTP %i", async (status) => {
    const port = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    expect(await probeForeignServer(port)).toBe(`(HTTP ${status})`);
  });

  it("refuses a 200 with no storagePath field", async () => {
    const port = await serve(json({}));
    expect(await probeForeignServer(port)).toBe("(no storagePath in /api/info)");
  });

  it("refuses a 200 whose body is literally null", async () => {
    // Valid JSON. Must not throw a raw TypeError past the refusal message.
    const port = await serve(json(null));
    expect(await probeForeignServer(port)).toBe("(no storagePath in /api/info)");
  });

  it("clears a port nobody is listening on", async () => {
    // The ONLY safe clear, and it must work — otherwise every clean local run
    // refuses and developers learn to route around the guard.
    const port = await serve(json({}));
    await new Promise((r) => servers.splice(0)[0].close(r));
    expect(await probeForeignServer(port)).toBeNull();
  });
});

describe("foreignServerMessage", () => {
  it("names the offending path, the expected one, and the remedy", () => {
    const msg = foreignServerMessage("C:\\Users\\someone\\tandem\\sessions", DEFAULT_MCP_PORT);
    expect(msg).toContain("C:\\Users\\someone\\tandem\\sessions");
    expect(msg).toContain(E2E_APP_DATA_DIR);
    expect(msg).toContain(String(DEFAULT_MCP_PORT));
    // The remedy has to be in the text: this error is the entire user interface
    // of the guard, and a developer who forgot to quit Tandem reads nothing else.
    expect(msg).toMatch(/Quit Tandem/);
  });

  it("does not name a specific suite — the screenshots config inherits it too", () => {
    expect(foreignServerMessage("x", 1)).not.toMatch(/\bE2E again\b/);
  });
});

/**
 * `runGuard` is the piece `globalSetup` actually calls. The probe rows above
 * pin the classification; these pin that a foreign verdict THROWS the refusal
 * (deleting the guard's throw while keeping the probe would pass every test
 * above and protect nothing).
 */
describe("runGuard", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("throws the refusal, naming the path and the port, for a foreign server", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ storagePath: "/home/someone/.local/share/tandem/sessions" }));
    });
    await expect(runGuard(port)).rejects.toThrow(
      /Refusing to run this Playwright suite[\s\S]*\/home\/someone\/.local\/share\/tandem\/sessions/,
    );
    await expect(runGuard(port)).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  it("passes a clear port", async () => {
    const port = await serve((_req, res) => res.end());
    await new Promise((r) => servers.splice(0)[0].close(r));
    await expect(runGuard(port)).resolves.toBeUndefined();
  });
});

/**
 * The served-client check (#1492). Fixtures are the two REAL shapes Vite 8 dev
 * serves for src/client/utils/backend-ports.ts, captured verbatim: an
 * env-object assignment prepended to the module. The module body always
 * mentions the env-var NAME (it reads it), so the name alone must never pass —
 * only the quoted port values prove which env the server was launched with.
 */
describe("assertServedClientTargetsHarness", () => {
  const BODY =
    'import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "/src/shared/constants.ts";\n' +
    "export const MCP_PORT = resolvePort(import.meta.env.VITE_TANDEM_MCP_PORT, DEFAULT_MCP_PORT);\n" +
    "export const WS_PORT = resolvePort(import.meta.env.VITE_TANDEM_WS_PORT, DEFAULT_WS_PORT);\n";
  const withHarnessEnv =
    `import.meta.env = {"BASE_URL": "/", "DEV": true, "MODE": "development", "PROD": false, "SSR": false, ` +
    `"VITE_TANDEM_MCP_PORT": "${E2E_MCP_PORT}", "VITE_TANDEM_WS_PORT": "${E2E_WS_PORT}"};` +
    BODY;
  const withoutEnv =
    `import.meta.env = {"BASE_URL": "/", "DEV": true, "MODE": "development", "PROD": false, "SSR": false};` +
    BODY;

  it("accepts the module as served by a Vite launched with the harness env", () => {
    expect(() => assertServedClientTargetsHarness(withHarnessEnv)).not.toThrow();
  });

  it("refuses the module as served by a Vite launched WITHOUT the env", () => {
    // The dangerous case: a hand-started `vite --port <E2E_VITE_PORT>` serving
    // a client baked to the product ports. The body still names the env var,
    // so a name-only check would clear it.
    // [\s\S]: the refusal wraps its message across lines mid-phrase.
    expect(() => assertServedClientTargetsHarness(withoutEnv)).toThrow(
      /does NOT target the[\s\S]*harness backend/,
    );
  });

  it("refuses when only one of the two ports is present", () => {
    const mcpOnly = `import.meta.env = {"VITE_TANDEM_MCP_PORT": "${E2E_MCP_PORT}"};` + BODY;
    expect(() => assertServedClientTargetsHarness(mcpOnly)).toThrow(/\(ws\)/);
  });
});

describe("fetchServedBackendPortsModule — fail closed", () => {
  it("throws (refusal), never returns, when nothing answers the Vite port", async () => {
    // Grab-and-release an ephemeral port so nothing is listening on it.
    const server = http.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r));
    await expect(fetchServedBackendPortsModule(port, 500)).rejects.toThrow(/cannot be verified/);
  });

  it("keeps a budget larger than the cheap probes', because a timeout is a refusal", () => {
    // This probe asks Vite to TRANSFORM a module for the first time, paying a
    // plugin-container warm-up the health check never touches. It shared the
    // 5s port-squatter budget and measured 4627ms on one healthy run, then
    // refused three consecutive runs when load pushed it over — and a refusal
    // here fails the whole suite while the thing it guards is fine.
    //
    // Pinned from source text because neither constant is exported, and
    // exporting a timeout purely to test it would be the tail wagging the dog.
    // What must not silently revert is the DEFAULT on this signature.
    const src = readFileSync(path.resolve(__dirname, "../../scripts/e2e-guard.ts"), "utf-8");
    const budgets = Object.fromEntries(
      [...src.matchAll(/const (\w*PROBE_TIMEOUT_MS) = ([\d_]+);/g)].map(([, k, v]) => [
        k,
        Number(v.replace(/_/g, "")),
      ]),
    );
    expect(budgets.PROBE_TIMEOUT_MS, "PROBE_TIMEOUT_MS vanished").toBeGreaterThan(0);
    expect(
      budgets.TRANSFORM_PROBE_TIMEOUT_MS,
      "the served-module probe lost its own budget and is back on the shared one",
    ).toBeGreaterThan(budgets.PROBE_TIMEOUT_MS);

    expect(
      src,
      "fetchServedBackendPortsModule's default timeout must be TRANSFORM_PROBE_TIMEOUT_MS — " +
        "on PROBE_TIMEOUT_MS it refuses healthy runs under load",
    ).toMatch(
      /fetchServedBackendPortsModule\([^)]*timeoutMs: number = TRANSFORM_PROBE_TIMEOUT_MS/s,
    );
  });
});
