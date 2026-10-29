/**
 * The channel permission relay is gone (#1885, closing #1884 at the source).
 *
 * The relay was three routes (`POST`/`GET /api/channel-permission` and
 * `POST /api/channel-permission-verdict`) around a server-side holding map.
 * It had no return leg — nothing could answer Claude Code's approval prompt —
 * and its GET served each prompt's `description` to any local caller. The shim
 * no longer declares `claude/channel/permission`
 * (`tests/channel/permission-capability.test.ts`), so the routes were deleted
 * rather than hardened.
 *
 * These specs pin the deletion from four sides: the exact route set
 * `registerChannelRoutes` registers, the absence of any permission key, the
 * absence of the path constants, and the absence of the routes' reference
 * headings in docs/mcp-tools.md. The non-loopback side — a LAN POST to either
 * old path is refused by the invariant — is pinned in
 * `api-loopback-invariant.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";
import * as apiPaths from "../../src/shared/api-paths.js";
import { makeRecorderApp } from "../helpers/route-recorder.js";

function registeredKeys(): string[] {
  const recorder = makeRecorderApp();
  registerChannelRoutes(
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express app double
    recorder.app as any,
    ((_req: unknown, _res: unknown, next: unknown) => {
      (next as () => void)?.();
    }) as never,
  );
  return [...recorder.routes.keys()].sort();
}

describe("channel permission relay withdrawn (#1885)", () => {
  it("registerChannelRoutes registers exactly the remaining channel routes", () => {
    expect(registeredKeys()).toEqual(
      [
        "GET /api/events",
        "OPTIONS /api/channel-awareness",
        "POST /api/channel-awareness",
        "OPTIONS /api/channel-error",
        "POST /api/channel-error",
        "OPTIONS /api/channel-reply",
        "POST /api/channel-reply",
        "OPTIONS /api/chat",
        "DELETE /api/chat",
      ].sort(),
    );
  });

  it("no registered route names channel-permission", () => {
    const keys = registeredKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.includes("channel-permission"))).toEqual([]);
  });

  it("api-paths exports no API_CHANNEL_PERMISSION* constant", () => {
    const names = Object.keys(apiPaths);
    expect(names).toContain("API_CHANNEL_REPLY");
    expect(names.filter((n) => n.startsWith("API_CHANNEL_PERMISSION"))).toEqual([]);
  });

  it("docs/mcp-tools.md no longer documents the relay routes", () => {
    const doc = readFileSync(join(__dirname, "..", "..", "docs", "mcp-tools.md"), "utf8");
    const headings = doc.split("\n").filter((l) => /^#{1,6}\s/.test(l));
    expect(headings.some((h) => h.includes("/api/channel-reply"))).toBe(true);
    expect(headings.filter((h) => h.includes("/api/channel-permission"))).toEqual([]);
  });
});
