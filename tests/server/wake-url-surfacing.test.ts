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

    // The JSON envelope alone CANNOT prove this: `JSON.stringify` drops an undefined
    // value, so a `{ wakeUrl: undefined }` bug reads identically there. `structuredContent`
    // is the raw object, so it is the only surface where absent-vs-present-undefined is
    // observable — and it is the surface a strict client validates against, where an
    // undefined key reads as a live transport that is not running.
    const structured = raw.structuredContent as Record<string, unknown> | undefined;
    if (structured !== undefined) {
      expect(Object.keys(structured)).not.toContain("wakeUrl");
    }
  });

  it("tandem_scratchpad's response alone is enough to arm from", () => {
    // The whole point of the change: this tool completes a task in one call, so if its
    // response did not carry both an id and an address, such a session could never arm.
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    return client
      .callTool({ name: "tandem_scratchpad", arguments: { content: "# Draft" } })
      .then((r) => {
        const res = parsed(r);
        expect(res.data.documentId).toBeTruthy();
        expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
      });
  });

  it("tandem_checkInbox never carries it, however the transport is running", async () => {
    // Deliberate exclusion, not an oversight: it is polled every 2-3 tool calls, so the
    // address would be re-presented dozens of times per session — the documented route to
    // a second watch, which burns a MAX_WAKE_CONSUMERS slot and makes the zero-subscriber
    // signal unreachable process-globally for every other session.
    expect(WAKE_URL_PRODUCERS).not.toContain("tandem_checkInbox");
  });
});
