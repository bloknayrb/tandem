/**
 * `tandem_save` — how `allowImageLoss` reaches the save path (#1941 review, cr-1).
 *
 * The MCP half of the override shipped pinned by NOTHING. Measured on
 * `757eeeca`: dropping the forwarded bag at `document.ts` (`saveDocumentToDisk(
 * r.docId, "mcp", { allowImageLoss })` → `saveDocumentToDisk(r.docId, "mcp")`)
 * left 229/229 tool-level tests green, while `docs/mcp-tools.md` and
 * `SKILL.md` v24 both instruct an agent that the parameter works. The five
 * files that mention `allowImageLoss` cover the ROUTE (`routes/save.ts`), the
 * CLIENT, and `saveDocumentToDisk` called DIRECTLY — none drives the
 * registered tool.
 *
 * So this suite drives the tool through a real `McpServer` + `Client`, which
 * is what makes it a pin on the forwarding rather than a restatement of
 * `saveDocumentToDisk`'s own behaviour. The service is mocked for exactly that
 * reason: the refusal lives INSIDE `saveDocumentToDisk`, so an outcome
 * assertion would pass however the tool forwarded the field — including not
 * forwarding it at all. Every assertion is over the ARGUMENT, mirroring
 * `tests/server/routes/save-allow-image-loss.test.ts` on the route side.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveDocumentToDisk = vi.hoisted(() => vi.fn());

// Spread the original: `document.ts` pulls a dozen symbols from this module
// (`requireDocument`, `getCurrentDoc`, the registry accessors), and the doc
// this suite opens has to resolve through the REAL ones or the handler never
// reaches the delegate under test.
//
// TYPED `vi.mock(import("…"), …)` form, not the string form: the typed overload
// checks this factory against `Partial<typeof module>`, so a double that omits
// members or returns a wrong shape fails `typecheck:tests` instead of failing
// at runtime in some later suite.
vi.mock(import("../../src/server/mcp/document-service.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  saveDocumentToDisk,
}));

import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

const DOC_ID = "save-aio-1";

let client: Client;

/** The third argument `tandem_save` handed to `saveDocumentToDisk`, if any. */
function optsOfFirstCall(): { allowImageLoss?: boolean } | undefined {
  return saveDocumentToDisk.mock.calls[0]?.[2] as { allowImageLoss?: boolean } | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  saveDocumentToDisk.mockResolvedValue({ status: "saved", filePath: "/tmp/pics.docx" });

  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);

  const ydoc = getOrCreateDocument(DOC_ID);
  populateYDoc(ydoc, "Text beside a picture.");
  addDoc(DOC_ID, {
    id: DOC_ID,
    filePath: "/tmp/pics.docx",
    format: "docx",
    readOnly: false,
    source: "file",
  });
  setActiveDocId(DOC_ID);

  const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
  registerDocumentTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

describe("tandem_save — allowImageLoss forwarding (#1941)", () => {
  it("forwards allowImageLoss: true to saveDocumentToDisk", async () => {
    await client.callTool({
      name: "tandem_save",
      arguments: { documentId: DOC_ID, allowImageLoss: true },
    });

    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      DOC_ID,
      "mcp",
      expect.objectContaining({ allowImageLoss: true }),
    );
  });

  it("does not send true when the parameter is omitted — the refusal still refuses", async () => {
    // The other mutation direction. `saveDocumentToDisk` refuses on anything
    // that is not `true`, so this is the assertion that catches a default
    // flipped to `true` at the tool layer — which would make an image-bearing
    // .docx save picture-less on an ordinary `tandem_save`.
    await client.callTool({ name: "tandem_save", arguments: { documentId: DOC_ID } });

    expect(saveDocumentToDisk).toHaveBeenCalledTimes(1);
    expect(optsOfFirstCall()?.allowImageLoss).not.toBe(true);
  });

  it("does not send true for an explicit allowImageLoss: false", async () => {
    await client.callTool({
      name: "tandem_save",
      arguments: { documentId: DOC_ID, allowImageLoss: false },
    });

    expect(optsOfFirstCall()?.allowImageLoss).not.toBe(true);
  });

  it("forwards an explicit false rather than dropping the bag entirely", async () => {
    // Distinct from the case above, which only says "not true". This pins that
    // the caller's explicit refusal actually travels: a handler that forwarded
    // `{}` (or nothing) would satisfy `not.toBe(true)` while quietly discarding
    // the parameter, which is the same silent-drop class cr-1 was about.
    await client.callTool({
      name: "tandem_save",
      arguments: { documentId: DOC_ID, allowImageLoss: false },
    });

    expect(optsOfFirstCall()).toBeDefined();
    expect(optsOfFirstCall()?.allowImageLoss).toBe(false);
  });

  it("rejects a non-boolean allowImageLoss at the schema, before any save", async () => {
    // The Zod type is the reason a truthy `"true"` string cannot reach the
    // destructive branch over MCP the way it could over a hand-rolled route.
    const result = await client.callTool({
      name: "tandem_save",
      arguments: { documentId: DOC_ID, allowImageLoss: "true" },
    });

    expect(result.isError).toBe(true);
    expect(saveDocumentToDisk).not.toHaveBeenCalled();
  });
});
