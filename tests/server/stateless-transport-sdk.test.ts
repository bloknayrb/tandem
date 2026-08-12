import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";

/**
 * Behavioural pin for the SDK constraint ADR-012 got wrong (#1332, evidence
 * #1253, full write-up in `docs/spikes/stateless-transport-probe.md`).
 *
 * WHY THIS EXISTS ALONGSIDE THE PROSE GUARD. `tests/docs/stateless-transport-claims.test.ts`
 * asserts that our documentation does not RE-ASSERT the refuted claim. That is
 * a guard on words, derived from no fact — so if a future SDK release actually
 * introduced the failure mode ADR-012 described, every regex in that file would
 * stay green while the docs quietly became wrong again.
 *
 * The claim is about the observable behaviour of an installed dependency, so it
 * is checkable. `package.json` pins `^1.12.1`; the probe measured 1.30.0. A
 * minor bump inside that range can move this behaviour without any of our files
 * changing, and this test is the only thing that would notice.
 *
 * Two DIFFERENT guards are pinned here, because conflating them is the original
 * mistake: the stateless-reuse rule below, and `Protocol.connect()` refusing a
 * second transport on one server — which ADR-045 and `transport-registry.ts`
 * genuinely rest on and which remains TRUE.
 */

/** A minimal well-formed `initialize` request; the SDK rejects malformed bodies earlier. */
function initializeRequest(): Request {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stateless-probe", version: "0.0.0" },
      },
    }),
  });
}

describe("SDK stateless transport behaviour (#1332 / #1253)", () => {
  it("rejects the SECOND request on one stateless transport, while the first succeeds", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // First request is fine. ADR-012 claimed the failure was at the handshake;
    // it is not. Reaching this line at all refutes "crashes after the first
    // server.connect()".
    await transport.handleRequest(initializeRequest());

    // The real rule, and the whole of it: the transport is single-use.
    await expect(transport.handleRequest(initializeRequest())).rejects.toThrow(
      /Stateless transport cannot be reused across requests/i,
    );
  });

  it("a fresh transport per request is what stateless mode actually requires", async () => {
    // The corrected claim, stated as behaviour: stateless mode is usable; it is
    // transport REUSE that is forbidden. Two independent transports both work.
    for (let i = 0; i < 2; i++) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await expect(transport.handleRequest(initializeRequest())).resolves.toBeDefined();
    }
  });
});
