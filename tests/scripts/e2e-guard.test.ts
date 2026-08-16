import path from "node:path";
import { describe, expect, it } from "vitest";
import { foreignServerMessage, isE2EStoragePath } from "../../scripts/e2e-guard";
import { E2E_APP_DATA_DIR } from "../../scripts/e2e-paths";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants";

/**
 * #1483. `globalSetup` itself needs a live port to exercise, so the decision it
 * rests on is extracted and tested here instead. The failure this guards is
 * destructive and deliberately never reproduced end to end: reproducing it means
 * running the E2E suite against real documents.
 */
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
});
