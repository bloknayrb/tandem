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

describe("wakeUrl surfacing — the session-opening tools", () => {
  it("tandem_scratchpad carries wakeUrl when a wake transport is running", async () => {
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    const res = parsed(
      await client.callTool({ name: "tandem_scratchpad", arguments: { content: "# Draft" } }),
    );

    expect(res.error).toBe(false);
    expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
    // The whole point: this response alone is enough to arm from.
    expect(res.data.documentId).toBeTruthy();
  });

  it("tandem_scratchpad OMITS the key entirely in stdio mode", async () => {
    mockedGetWakeEndpoint.mockReturnValue(null);

    const res = parsed(
      await client.callTool({ name: "tandem_scratchpad", arguments: { content: "# Draft" } }),
    );

    expect(res.error).toBe(false);
    // Absent, not undefined — a present-but-undefined key reads as a live
    // transport to `Object.keys` and to a strict client.
    expect(Object.keys(res.data)).not.toContain("wakeUrl");
  });

  it("tandem_open carries wakeUrl when a wake transport is running", async () => {
    const filePath = join(tmpdir(), `wake-url-open-${Date.now()}.md`);
    await fs.writeFile(filePath, "# Opened\n");
    tempFiles.push(filePath);
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    const res = parsed(await client.callTool({ name: "tandem_open", arguments: { filePath } }));

    expect(res.error).toBe(false);
    expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
  });

  it("tandem_open OMITS the key entirely in stdio mode", async () => {
    const filePath = join(tmpdir(), `wake-url-open-none-${Date.now()}.md`);
    await fs.writeFile(filePath, "# Opened\n");
    tempFiles.push(filePath);
    mockedGetWakeEndpoint.mockReturnValue(null);

    const res = parsed(await client.callTool({ name: "tandem_open", arguments: { filePath } }));

    expect(res.error).toBe(false);
    expect(Object.keys(res.data)).not.toContain("wakeUrl");
  });

  it("read-mode tandem_status still carries it — the original producer is unchanged", async () => {
    mockedGetWakeEndpoint.mockReturnValue(LIVE_WAKE_URL);

    const res = parsed(await client.callTool({ name: "tandem_status", arguments: {} }));

    expect(res.error).toBe(false);
    expect(res.data.wakeUrl).toBe(LIVE_WAKE_URL);
  });
});
