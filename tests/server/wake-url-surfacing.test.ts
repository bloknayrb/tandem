/**
 * Which tool responses carry `wakeUrl`.
 *
 * The wake watch used to be reachable only through read-mode `tandem_status`,
 * because that was the sole caller of `getWakeEndpoint()`. A session whose task
 * fit in one call — `tandem_scratchpad({ content })` seeds a draft tab and is
 * DONE — therefore never obtained a `wakeUrl`, and `SKILL.md` correctly forbids
 * guessing one (a wrong port opens a socket to an unrelated service and looks
 * armed). So that session could not arm, and the model was following the skill.
 *
 * These specs pin the widened set. The ABSENT half matters as much as the
 * present one: in stdio mode no wake transport is attached, `getWakeEndpoint()`
 * is null, and the key must be missing rather than present-and-undefined —
 * `Object.keys` and a strict client both see the difference that
 * `JSON.stringify` hides.
 *
 * `tandem_checkInbox` is deliberately NOT in this set. It is polled every 2-3
 * tool calls, so carrying `wakeUrl` there re-presents the arm affordance dozens
 * of times per session — the documented route to a second watch (see
 * `wake-advisory.ts`), which also burns a `MAX_WAKE_CONSUMERS` slot and makes
 * the zero-subscriber signal unreachable for every other session.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/events/wake-socket.js", () => ({
  getWakeEndpoint: vi.fn(() => null as string | null),
}));

import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getWakeEndpoint } from "../../src/server/events/wake-socket.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { WAKE_URL_PRODUCERS } from "../../src/server/mcp/wake-url.js";

const mockedGetWakeEndpoint = vi.mocked(getWakeEndpoint);
const LIVE_WAKE_URL = "ws://127.0.0.1:41999/api/wake";

let client: Client;
const tempFiles: string[] = [];

type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function parsed(result: CallToolResponse) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  mockedGetWakeEndpoint.mockReturnValue(null);

  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  registerAwarenessTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  for (const f of tempFiles.splice(0)) await fs.rm(f, { force: true });
});

/** A real file on disk for `tandem_open`, cleaned up in `afterEach`. */
async function tempMarkdown(): Promise<string> {
  const filePath = join(tmpdir(), `wake-url-${Date.now()}-${tempFiles.length}.md`);
  await fs.writeFile(filePath, "# Opened\n");
  tempFiles.push(filePath);
  return filePath;
}

describe("wakeUrl surfacing — the session-opening tools", () => {
  /**
   * Driven off `WAKE_URL_PRODUCERS` rather than a hand-written spec per tool, so a fourth
   * producer added to the constant with no row here fails immediately instead of shipping
   * untested. The hand-written form also hid a gap: `tandem_status` had a "carries" spec
   * and no "omits" spec, which is invisible until the cases are lined up.
   */
  const CASES: Record<(typeof WAKE_URL_PRODUCERS)[number], () => Promise<Record<string, unknown>>> =
    {
      tandem_status: async () => ({}),
      tandem_scratchpad: async () => ({ content: "# Draft" }),
      tandem_open: async () => ({ filePath: await tempMarkdown() }),
    };

  it("every declared producer has a case — a new one cannot ship untested", () => {
    expect(Object.keys(CASES).sort()).toEqual([...WAKE_URL_PRODUCERS].sort());
  });

  it.each(
    WAKE_URL_PRODUCERS,
  )("%s carries wakeUrl when a wake transport is running", async (tool) => {
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    const res = parsed(await client.callTool({ name: tool, arguments: await CASES[tool]() }));

    expect(res.error).toBe(false);
    expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
  });

  it.each(WAKE_URL_PRODUCERS)("%s OMITS the key entirely in stdio mode", async (tool) => {
    mockedGetWakeEndpoint.mockReturnValue(null);

    const raw = await client.callTool({ name: tool, arguments: await CASES[tool]() });
    const res = parsed(raw);

    expect(res.error).toBe(false);
    expect(Object.keys(res.data)).not.toContain("wakeUrl");

    // `structuredContent` is only set by `mcpStructured`, so it exists for `tandem_status` and
    // NOT for the two `mcpSuccess` producers. That is not a hole in this spec: for an
    // `mcpSuccess` tool the absent-vs-present-undefined distinction is genuinely UNOBSERVABLE
    // on the wire, because `JSON.stringify` drops an undefined value — measured, an envelope
    // assertion here is a guard that cannot fail. The invariant is real but belongs to the
    // helper, so it is asserted directly in `wake-url-seam.test.ts` rather than faked here.
    const structured = raw.structuredContent as Record<string, unknown> | undefined;
    if (structured !== undefined) {
      expect(Object.keys(structured)).not.toContain("wakeUrl");
    }
  });

  it("tandem_scratchpad's response alone is enough to arm from", async () => {
    // The whole point of the change: this tool completes a task in one call, so if its
    // response did not carry both an id and an address, such a session could never arm. The
    // table row above covers the address; this adds the id, which is what makes the response
    // self-sufficient rather than merely correct.
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    const res = parsed(
      await client.callTool({ name: "tandem_scratchpad", arguments: { content: "# Draft" } }),
    );
    expect(res.data.documentId).toBeTruthy();
    expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
  });

  it("tandem_checkInbox never carries it, however the transport is running", async () => {
    // Deliberate exclusion, not an oversight: it is polled every 2-3 tool calls, so the
    // address would be re-presented dozens of times per session — the documented route to
    // a second watch, which burns a MAX_WAKE_CONSUMERS slot and makes the zero-subscriber
    // signal unreachable process-globally for every other session.
    //
    // This used to assert `WAKE_URL_PRODUCERS` did not contain the name — a tautology over a
    // literal, which could not have noticed a `...wakeUrlField()` added to the handler. Call
    // the tool for real, with the transport LIVE, which is what the title claims.
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    // A document must be OPEN first. `beforeEach` clears the registry, and `tandem_checkInbox`
    // answers NO_DOCUMENT with no `data` — against which `Object.keys(res.data ?? {})` is
    // vacuously true. Measured: without this open, a `wakeUrl` deliberately added to the
    // checkInbox payload left this spec green. Assert the success envelope before the absence.
    await client.callTool({ name: "tandem_scratchpad", arguments: { content: "# Draft" } });

    const raw = await client.callTool({ name: "tandem_checkInbox", arguments: {} });
    const res = parsed(raw);
    expect(res.error, `checkInbox did not succeed: ${JSON.stringify(res)}`).toBe(false);
    expect(Object.keys(res.data ?? {}), "control: the payload was empty").toContain("summary");
    expect(Object.keys(res.data ?? {})).not.toContain("wakeUrl");

    const structured = raw.structuredContent as Record<string, unknown> | undefined;
    if (structured !== undefined) {
      expect(Object.keys(structured)).not.toContain("wakeUrl");
    }
  });
});
