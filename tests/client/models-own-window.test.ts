// @vitest-environment happy-dom

/**
 * #2404 — is this page one the server lets change the local-model settings?
 * The client decides from its own page origin (`models/own-window.ts`),
 * because a page at `http://localhost:<port>` cannot read the server's
 * refusal at all. Pure function first, then the shared store and its latch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetModelsWriteAccessForTests,
  _setPageOriginForTests,
  createModelsWriteAccess,
  modelsPageAccess,
} from "../../src/client/hooks/useModelsWriteAccess.svelte";
import { modelsWriteAccess, ownWindowNotice } from "../../src/client/models/own-window";
import { noteModelsWriteRefused } from "../../src/client/models/write-refusal";
import { MCP_BASE_URL } from "../../src/client/utils/backend-ports";

const OWN = "http://127.0.0.1:3479";

describe("modelsWriteAccess — the page's own origin", () => {
  it.each([
    ["the page Tandem's own server serves", OWN, false, "own"],
    ["the desktop window on Windows", "http://tauri.localhost", true, "own"],
    ["the desktop window, https form", "https://tauri.localhost", true, "own"],
    ["the desktop window on macOS and Linux", "tauri://localhost", true, "own"],
    ["the Vite dev client", "http://127.0.0.1:5173", false, "unknown"],
    ["the E2E client", "http://127.0.0.1:4573", false, "unknown"],
    [
      "the dev:tauri window (Vite's origin inside the desktop shell)",
      "http://127.0.0.1:5173",
      true,
      "unknown",
    ],
    ["a desktop window with an origin string nobody expected", "null", true, "unknown"],
    ["nowhere with a window at all", null, false, "unknown"],
    ["the same port reached as localhost", "http://localhost:3479", false, "foreign"],
    [
      "a page on port 8080 reached as tauri.localhost",
      "http://tauri.localhost:8080",
      false,
      "foreign",
    ],
    ["an opaque origin", "null", false, "foreign"],
    ["https on the loopback address", "https://127.0.0.1:3479", false, "foreign"],
    ["a lookalike host", "http://127.0.0.1.evil.example:3479", false, "foreign"],
    ["another site", "https://example.com", false, "foreign"],
  ] as const)("%s (%s) → %s", (_what, origin, isTauri, expected) => {
    expect(modelsWriteAccess(origin, isTauri, OWN)).toBe(expected);
  });

  it("the own address is the one every API call already goes to", () => {
    expect(MCP_BASE_URL).toBe(OWN);
  });
});

describe("ownWindowNotice — what the tab says", () => {
  it("a page that is plainly elsewhere is told the address to open, and not about the variable", () => {
    const text = ownWindowNotice("foreign", "http://localhost:3479", OWN);
    expect(text).toBe(
      "These settings can only be changed in Tandem's own window. Open Tandem at http://127.0.0.1:3479, or use the Tandem desktop app.",
    );
    expect(text).not.toContain("TANDEM_MODELS_DEV_ORIGIN");
  });

  it("a refused page on another loopback port is told about the development variable, with its own address", () => {
    const text = ownWindowNotice("unknown", "http://127.0.0.1:5173", OWN);
    expect(text).toBe(
      "These settings can only be changed in Tandem's own window. This page is served from http://127.0.0.1:5173. In a development setup, start Tandem's server with TANDEM_MODELS_DEV_ORIGIN=http://127.0.0.1:5173, then reload this page.",
    );
  });
});

describe("ownWindowNotice — never suggests a value the server would refuse", () => {
  const BASE = "These settings can only be changed in Tandem's own window.";

  it.each([
    ["port 80, which a browser writes with no port", "http://127.0.0.1"],
    ["an explicit port 80", "http://127.0.0.1:80"],
    ["a port out of range", "http://127.0.0.1:65536"],
    ["a desktop window whose origin string is the opaque 'null'", "null"],
    ["a desktop window with some other unexpected origin", "tauri://something-else"],
  ])("%s gets the plain sentence, with no variable and no 'served from'", (_what, origin) => {
    const text = ownWindowNotice("unknown", origin, OWN);
    expect(text).toBe(BASE);
  });

  it("a page the client calls its own, refused all the same, gets the plain sentence", () => {
    expect(ownWindowNotice("own", OWN, OWN)).toBe(BASE);
    expect(ownWindowNotice("own", "http://tauri.localhost", OWN)).toBe(BASE);
  });

  it("no window at all gets the plain sentence", () => {
    expect(ownWindowNotice("unknown", null, OWN)).toBe(BASE);
  });

  it("the variable is offered exactly when the origin has the form the server accepts", () => {
    for (const ok of ["http://127.0.0.1:5173", "http://127.0.0.1:1", "http://127.0.0.1:65535"]) {
      expect(ownWindowNotice("unknown", ok, OWN)).toContain(`TANDEM_MODELS_DEV_ORIGIN=${ok},`);
    }
  });
});

describe("the shared store", () => {
  beforeEach(() => _resetModelsWriteAccessForTests());
  afterEach(() => _resetModelsWriteAccessForTests());

  it("Tandem's own page is not blocked", () => {
    _setPageOriginForTests(OWN);
    expect(modelsPageAccess()).toBe("own");
    expect(createModelsWriteAccess().blocked).toBe(false);
  });

  it("a page at localhost is blocked before any request is made", () => {
    _setPageOriginForTests("http://localhost:3479");
    expect(createModelsWriteAccess().blocked).toBe(true);
  });

  it("a dev page is live until the server refuses a write, then blocked for good", () => {
    _setPageOriginForTests("http://127.0.0.1:5173");
    const access = createModelsWriteAccess();
    expect(access.blocked).toBe(false);
    noteModelsWriteRefused();
    expect(access.blocked).toBe(true);
    expect(access.notice).toContain("TANDEM_MODELS_DEV_ORIGIN=http://127.0.0.1:5173");
  });

  it("with no override it reads the real page origin", () => {
    // Whatever this test environment's page is, it is not Tandem's own.
    expect(window.location.origin).not.toBe(OWN);
    expect(modelsPageAccess()).toBe(modelsWriteAccess(window.location.origin, false, OWN));
    expect(modelsPageAccess()).not.toBe("own");
  });
});
