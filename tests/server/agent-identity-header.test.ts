/**
 * `X-Tandem-Agent-Provider` is the header that decides which assistant an MCP
 * session's annotations are attributed to. Its own doc comment in
 * `shared/cli-runtime.ts` describes it as "validated ... forwarded only by
 * Tandem's managed stdio bridge", and until #1265's review neither half was
 * enforced: any value was silently ignored rather than rejected, and any client
 * that could reach `/mcp` could assert it — including a LAN client under
 * `TANDEM_BIND_HOST`, which would let a remote caller publish annotations
 * bylined "Codex".
 *
 * These tests pin the gate itself rather than a route, because the loopback
 * branch is unreachable through `createMcpExpressApp` without binding a real
 * non-loopback interface.
 */

import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { readAgentIdentityHeader } from "../../src/server/mcp/server.js";
import { TANDEM_AGENT_PROVIDER_HEADER } from "../../src/shared/cli-runtime.js";

const HEADER = TANDEM_AGENT_PROVIDER_HEADER.toLowerCase();

function req(
  headers: Record<string, string | string[]>,
  remoteAddress: string | undefined,
): Pick<Request, "headers" | "socket"> {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Pick<Request, "headers" | "socket">;
}

describe("readAgentIdentityHeader", () => {
  it("accepts the Codex identity from a loopback client", () => {
    expect(readAgentIdentityHeader(req({ [HEADER]: "openai" }, "127.0.0.1"))).toEqual({
      provider: "openai",
      displayName: "Codex",
    });
  });

  // The security assertion. Paired with the positive case above so "returns
  // undefined" is a real result rather than a function that always declines.
  it("refuses the same header from a non-loopback client", () => {
    expect(readAgentIdentityHeader(req({ [HEADER]: "openai" }, "192.168.1.50"))).toBeUndefined();
  });

  it("refuses it when the peer address is unknown", () => {
    // `isLoopback(undefined)` is false — a socket with no remote address is not
    // provably local, and this gate must fail closed.
    expect(readAgentIdentityHeader(req({ [HEADER]: "openai" }, undefined))).toBeUndefined();
  });

  it("ignores an unrecognized provider value", () => {
    expect(readAgentIdentityHeader(req({ [HEADER]: "anthropic" }, "127.0.0.1"))).toBeUndefined();
  });

  // A repeated header arrives as an array; `raw === "openai"` is false for it,
  // so the array can never smuggle a value past the enum check.
  it("ignores a repeated header", () => {
    expect(
      readAgentIdentityHeader(req({ [HEADER]: ["openai", "openai"] }, "127.0.0.1")),
    ).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    expect(readAgentIdentityHeader(req({}, "127.0.0.1"))).toBeUndefined();
  });
});
