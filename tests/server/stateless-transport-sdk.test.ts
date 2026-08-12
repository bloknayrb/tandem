import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Behavioural pin for the SDK constraint ADR-012 got wrong (#1332, evidence
 * #1253, write-up in `docs/spikes/stateless-transport-probe.md`).
 *
 * WHY THIS EXISTS ALONGSIDE THE PROSE GUARD. `tests/docs/stateless-transport-claims.test.ts`
 * asserts that our documentation does not RE-ASSERT the refuted claim. That is
 * a guard on words, derived from no fact — so if a future SDK release actually
 * introduced the failure mode ADR-012 described, every regex in that file would
 * stay green while the docs quietly became wrong again.
 *
 * `package.json` pins `^1.12.1`; the probe measured 1.30.0. A minor bump inside
 * that range can move this behaviour without any of our files changing, and
 * these tests are the only thing that would notice.
 *
 * Three claims are pinned, one per test, because the spike rests on all three
 * and only the first was ever measured:
 *   1. the stateless-reuse rule, on the web-standard transport;
 *   2. that the NODE transport Tandem actually ships inherits it, and that the
 *      throw surfaces as a bare 500 — the spike's explanation for why 2024 read
 *      this as a "crash";
 *   3. `Protocol.connect()` refusing a second transport on one server, which is
 *      a DIFFERENT and still-true guard. Conflating it with (1) is the original
 *      mistake, so leaving it unpinned would be the wrong thing to leave out.
 */

const OPEN: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/** A well-formed `initialize` body; the SDK rejects malformed input earlier. */
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stateless-probe", version: "0.0.0" },
  },
});

const INITIALIZE_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function initializeRequest(): Request {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: INITIALIZE_HEADERS,
    body: INITIALIZE_BODY,
  });
}

describe("SDK stateless transport behaviour (#1332 / #1253)", () => {
  it("rejects the SECOND request on one stateless transport, while the first succeeds", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    OPEN.push({ close: () => transport.close() });

    // ADR-012 claimed the failure was at the handshake. It is not: the first
    // request is served. This resolving IS the refutation.
    const first = await transport.handleRequest(initializeRequest());
    expect(first.status).toBe(200);

    // Behaviour — this must never change while the correction stands.
    await expect(transport.handleRequest(initializeRequest())).rejects.toThrow();

    // Doc fidelity, asserted separately so the failure is legible: the spike
    // quotes this string verbatim and `stateless-transport-claims.test.ts`
    // asserts the quote is present. If ONLY this line fails, the SDK reworded
    // its message and the spike needs the new wording — not a behaviour change.
    await expect(transport.handleRequest(initializeRequest())).rejects.toThrow(
      /Stateless transport cannot be reused across requests/i,
    );
  });

  it("the NODE transport Tandem ships inherits the rule, surfacing it as a bare 500", async () => {
    // `src/server/mcp/server.ts` constructs the Node class, not the web-standard
    // one. That it delegates is a source read; this measures it. The empty-bodied
    // 500 is also the spike's account of why this was read as a crash in 2024 —
    // the client sees no error text at all.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer((req, res) => {
      void transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    OPEN.push({ close: () => closeServer(server) });
    OPEN.push({ close: () => transport.close() });

    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const post = () =>
      fetch(url, { method: "POST", headers: INITIALIZE_HEADERS, body: INITIALIZE_BODY });

    const first = await post();
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const second = await post();
    expect(second.status).toBe(500);
    expect(await second.text()).toBe("");
  });

  it("Protocol.connect() still refuses a second transport on one server", async () => {
    // The guard ADR-045 and `transport-registry.ts` genuinely rest on. Still
    // true, and deliberately NOT the same rule as the stateless one above.
    const server = new McpServer({ name: "probe", version: "0.0.0" });
    const first = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const second = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    OPEN.push({ close: () => server.close() });

    await server.connect(first);
    await expect(server.connect(second)).rejects.toThrow(/already connected/i);
  });
});

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
