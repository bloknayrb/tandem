import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  foreignServerMessage,
  isContainedIn,
  isE2EStoragePath,
  probeForeignServer,
} from "../../scripts/e2e-guard";
import { E2E_APP_DATA_DIR } from "../../scripts/e2e-paths";
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
