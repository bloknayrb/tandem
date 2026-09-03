/**
 * #1796 — shape test for `tandem_convertToMarkdown`'s handler catch in
 * `document.ts:1341-1349`.
 *
 * `convert.ts` is mocked out entirely so this file can drive every thrown
 * `code` directly, including one the handler does not enumerate. Without that
 * last case, a `return noDocumentError()` default arm passes every case above
 * AND still misreports `EACCES`/`ENOTDIR`/`ENOSPC`/`CONFLICT` from a bad
 * `outputPath` as "no document is open" — which is the issue's own headline.
 *
 * Follows the `tests/server/routes/response-path-scrub.test.ts` pattern:
 * `vi.mock` before the dynamic `import` of the module under test, because
 * `document.ts:33` imports `convertToMarkdown` as a plain named ESM import and
 * `convert.ts` exports only `convertToMarkdown` plus a type, so the mock
 * factory below is complete.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const convertToMarkdown = vi.fn();
vi.mock("../../src/server/mcp/convert.js", () => ({ convertToMarkdown }));

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

function throwing(code: string): void {
  convertToMarkdown.mockRejectedValueOnce(Object.assign(new Error("anything at all"), { code }));
}

describe("tandem_convertToMarkdown error mapping — shape test (#1796)", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await setupClient();
  });

  it.each([
    ["FILE_NOT_FOUND", "FILE_NOT_FOUND"],
    ["INVALID_PATH", "INVALID_PATH"],
    ["EMPTY_CONVERSION", "EMPTY_CONVERSION"],
    ["OPEN_FAILED", "OPEN_FAILED"],
    ["CONFLICT", "CONFLICT"],
    ["PERMISSION_DENIED", "PERMISSION_DENIED"],
  ])("thrown %s maps 1:1 to code %s, with the message echoed", async (thrownCode, expectedCode) => {
    throwing(thrownCode);

    const result = await client.callTool({ name: "tandem_convertToMarkdown", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe(expectedCode);
    expect(parsed.message).toBe("anything at all");
  });

  it("thrown UNSUPPORTED_FORMAT maps to FORMAT_ERROR (the one code that IS a format error)", async () => {
    throwing("UNSUPPORTED_FORMAT");

    const result = await client.callTool({ name: "tandem_convertToMarkdown", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FORMAT_ERROR");
    expect(parsed.message).toBe("anything at all");
  });

  // The headline case: an unenumerated code must NOT fall through to
  // NO_DOCUMENT. A `noDocumentError()` default arm passes every case above
  // and still mis-labels this one.
  it("thrown ENOTDIR (unenumerated) rethrows to withErrorBoundary's INTERNAL_ERROR, not NO_DOCUMENT", async () => {
    throwing("ENOTDIR");

    const result = await client.callTool({ name: "tandem_convertToMarkdown", arguments: {} });
    const parsed = parseResult(result);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(parsed.code).not.toBe("NO_DOCUMENT");
  });
});
