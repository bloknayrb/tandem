/**
 * Wire-code rows that need a mocked seam to reach (#1851, #1823).
 *
 * `document-service.js` is mocked with an `importOriginal` spread so only the
 * named functions are replaced; `document.ts` imports them as plain named ESM
 * imports, so the override is what the handler calls. The real-tool rows live
 * in `mcp-wire-codes.test.ts`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renameDocument = vi.fn();
vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/mcp/document-service.js")>()),
  renameDocument,
}));

const { registerDocumentTools } = await import("../../src/server/mcp/document.js");

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("tandem_rename narrows renameDocument's open errorCode (#1851)", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await setupClient();
  });

  async function rename() {
    return parseResult(
      await client.callTool({
        name: "tandem_rename",
        arguments: { newName: "b.md", documentId: "doc-1" },
      }),
    );
  }

  it("a raw errno arrives as RENAME_FAILED, with the errno in details.errorCode", async () => {
    renameDocument.mockResolvedValueOnce({
      status: "error",
      reason: "The document could not be renamed.",
      errorCode: "EXDEV",
    });
    const parsed = await rename();
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("RENAME_FAILED");
    expect(parsed.details).toEqual({ errorCode: "EXDEV" });
    expect(parsed.message).toBe("The document could not be renamed.");
  });

  it("a listed semantic code passes through as the wire code", async () => {
    renameDocument.mockResolvedValueOnce({
      status: "error",
      reason: "A file with that name already exists.",
      errorCode: "ALREADY_EXISTS",
    });
    const parsed = await rename();
    expect(parsed.code).toBe("ALREADY_EXISTS");
    expect(parsed.details).toBeUndefined();
  });
});
