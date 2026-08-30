/**
 * `tools/list` must advertise no JSON Schema dialect (#1564).
 *
 * Claude Code's MCP client validates advertised output schemas as JSON Schema
 * 2020-12 only, and rejects a tool declaring any other dialect **client-side**,
 * before a call reaches this server. The SDK converts our zod shapes with
 * `zod-to-json-schema` at its default target, which stamps draft-07 on every
 * one — so the seven `outputSchema` tools, `tandem_checkInbox` and
 * `tandem_status` among them, silently vanished from live sessions while raw
 * JSON-RPC kept working.
 *
 * ## Why this drives real HTTP
 *
 * The strip wraps a handler the SDK installs, from a private map, inside
 * `createMcpServer`. A test that assembled its own `McpServer` from the same
 * `register*Tools` calls would pass whether or not the production factory
 * applies it — which is the whole failure this is meant to catch. So the
 * assertions run against `startMcpServerHttp`, over the wire, through the same
 * transport a client uses.
 *
 * ## The two ways this could pass while asserting nothing
 *
 *  1. **The SDK stops emitting `$schema` on its own.** Then "no `$schema`"
 *     holds with the strip removed, and the module is dead code nobody notices.
 *     `it("still has something to strip")` builds a bare SDK server and asserts
 *     the raw conversion DOES stamp a dialect. When that turns red, delete the
 *     module rather than the test.
 *  2. **The strip drops the schemas entirely.** `{}` also has no `$schema`. So
 *     the tool inventory, the seven output schemas, and the interior of one of
 *     them are pinned too.
 */

import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  installSchemaDialectStrip,
  stripSchemaDialect,
  stripToolSchemaDialects,
} from "../../src/server/mcp/schema-dialect.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

const MCP_ACCEPT = "application/json, text/event-stream";

/** The tools that declare an `outputSchema` — the exact set #1564 knocked out. */
const OUTPUT_SCHEMA_TOOLS = [
  "tandem_checkInbox",
  "tandem_diagnostics",
  "tandem_getAnnotations",
  "tandem_getTextContent",
  "tandem_listDocuments",
  "tandem_search",
  "tandem_status",
];

interface Tool {
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

let httpServer: Server;
let baseUrl: string;

/**
 * The transport answers with SSE, so the JSON-RPC payload is a `data:` line.
 *
 * Matched by request id rather than by taking the first frame: only one frame
 * rides this stream today, but a notification interleaved on it would otherwise
 * be parsed as the response and surface as a TypeError on `.tools` instead of a
 * readable failure.
 */
function parseRpc(body: string, id: number): Record<string, unknown> {
  const frames = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>);
  const match = frames.find((f) => f.id === id);
  expect(match, `no JSON-RPC frame with id ${id} in ${body}`).toBeDefined();
  return match as Record<string, unknown>;
}

/** Initialize a session and return its `tools/list` payload. */
async function listToolsOverHttp(): Promise<Tool[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dialect-test", version: "1.0.0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id") ?? "";
  await init.text();
  expect(sessionId).not.toBe("");

  const withSession = { ...headers, "mcp-session-id": sessionId };
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const rpc = parseRpc(await res.text(), 2);
  expect(rpc.result, `tools/list returned no result: ${JSON.stringify(rpc)}`).toBeDefined();
  return (rpc.result as { tools: Tool[] }).tools;
}

/** Every JSON-pointer path at which `key` appears, at any depth. */
function pathsTo(value: unknown, key: string, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => pathsTo(v, key, `${path}/${i}`));
  if (value === null || typeof value !== "object") return [];
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([k, v]) => {
    const here = k === key ? [`${path}/${k}`] : [];
    return [...here, ...pathsTo(v, key, `${path}/${k}`)];
  });
}

/**
 * Constructs whose meaning MOVED between draft-07 and 2020-12.
 *
 * Removing `$schema` is only a no-op while none of these appear: array-form
 * `items` became `prefixItems`, `additionalItems` became `items`,
 * `dependencies` split into `dependentSchemas`/`dependentRequired`, and a
 * `$ref` that draft-07 read alone now applies its siblings. If one shows up,
 * stripping the dialect starts changing what the schema MEANS, and the answer
 * is to reshape the zod source rather than to relax this test.
 */
function dialectSensitive(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => dialectSensitive(v, `${path}/${i}`));
  if (value === null || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const hits: string[] = [];
  if (Array.isArray(obj.items)) hits.push(`${path}/items (array form)`);
  if ("additionalItems" in obj) hits.push(`${path}/additionalItems`);
  if ("dependencies" in obj) hits.push(`${path}/dependencies`);
  if ("$ref" in obj) {
    const siblings = Object.keys(obj).filter((k) => k !== "$ref" && k !== "description");
    if (siblings.length > 0) hits.push(`${path}/$ref (siblings: ${siblings.join(",")})`);
  }
  return [...hits, ...Object.entries(obj).flatMap(([k, v]) => dialectSensitive(v, `${path}/${k}`))];
}

describe("advertised tool schemas declare no dialect (#1564)", () => {
  // Scoped to this block: the unit describes below are pure, and hooks at file
  // scope would boot and tear down a real HTTP server for each of them.
  beforeEach(async () => {
    const port = await allocPort();
    baseUrl = `http://127.0.0.1:${port}`;
    httpServer = await startMcpServerHttp(port, "127.0.0.1");
  });

  afterEach(async () => {
    await closeMcpSession();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("emits no $schema on any input or output schema", async () => {
    const tools = await listToolsOverHttp();
    const offenders = tools.flatMap((t) => [
      ...pathsTo(t.inputSchema, "$schema").map((p) => `${t.name}.inputSchema${p}`),
      ...pathsTo(t.outputSchema, "$schema").map((p) => `${t.name}.outputSchema${p}`),
    ]);
    expect(offenders).toEqual([]);
  });

  it("still advertises every tool, and every output schema, with its interior intact", async () => {
    const tools = await listToolsOverHttp();
    // A strip that replaced the schemas with `{}` would satisfy the test above,
    // and one that dropped a few tools would satisfy a `>=` floor.
    // `tests/docs/tool-count-drift.test.ts` pins this number independently.
    expect(tools.length).toBe(33);
    expect(
      tools
        .filter((t) => t.outputSchema)
        .map((t) => t.name)
        .sort(),
    ).toEqual(OUTPUT_SCHEMA_TOOLS);
    const status = tools.find((t) => t.name === "tandem_status");
    const props = status?.outputSchema?.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain("mode");
    expect(Object.keys(props)).toContain("openDocuments");
    expect(status?.outputSchema?.type).toBe("object");
    const input = tools.find((t) => t.name === "tandem_edit")?.inputSchema;
    expect(Object.keys(input?.properties as Record<string, unknown>)).toContain("newText");
  });

  it("emits nothing whose meaning depends on the dialect it no longer declares", async () => {
    const tools = await listToolsOverHttp();
    const hits = tools.flatMap((t) => [
      ...dialectSensitive(t.inputSchema, `${t.name}.inputSchema`),
      ...dialectSensitive(t.outputSchema, `${t.name}.outputSchema`),
    ]);
    expect(hits).toEqual([]);
  });

  it("still has something to strip", async () => {
    // The SDK's UNWRAPPED conversion, asserted directly. If this goes red the
    // SDK stopped stamping a dialect and schema-dialect.ts is dead code —
    // delete the module, not this assertion. Until then it is what stops the
    // three tests above from passing vacuously.
    const bare = new McpServer({ name: "bare", version: "0.0.1" });
    bare.registerTool(
      "probe",
      { description: "d", inputSchema: { a: z.string() }, outputSchema: { b: z.string() } },
      async () => ({ content: [], structuredContent: { b: "x" } }),
    );
    const handlers = (
      bare.server as unknown as {
        _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const raw = handlers.get("tools/list");
    expect(raw).toBeDefined();
    const listed = (await raw?.({ method: "tools/list", params: {} }, {})) as { tools: Tool[] };
    expect(listed.tools[0].inputSchema?.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(listed.tools[0].outputSchema?.$schema).toBe("http://json-schema.org/draft-07/schema#");

    // And the strip, applied to that same raw output, removes exactly that.
    const stripped = stripToolSchemaDialects(listed);
    expect(stripped.tools[0].inputSchema?.$schema).toBeUndefined();
    expect(stripped.tools[0].inputSchema?.properties).toEqual({ a: { type: "string" } });
  });
});

describe("the walkers this file's assertions are made of", () => {
  // Every use of these two is an `expect(...).toEqual([])`, so a walker that
  // silently stopped working — a typo in the key, a dropped recursion, an early
  // return — would make three tests permanently green while asserting nothing.
  // A mutation sweep over production code cannot catch a broken test helper.
  it("pathsTo finds a nested key", () => {
    expect(pathsTo({ a: { $schema: "x" } }, "$schema")).toEqual(["/a/$schema"]);
    expect(pathsTo({ anyOf: [{ $schema: "x" }] }, "$schema")).toEqual(["/anyOf/0/$schema"]);
    expect(pathsTo({ a: { type: "string" } }, "$schema")).toEqual([]);
  });

  it("dialectSensitive flags each construct whose meaning moved", () => {
    // Each of these is a real 2020-12 incompatibility, not a stylistic one:
    // array-form `items` hard-fails an Ajv2020 compile, `additionalItems` fails
    // in strict mode, and a `$ref` sibling that draft-07 ignored now applies.
    expect(dialectSensitive({ type: "array", items: [{ type: "string" }] })).toHaveLength(1);
    expect(dialectSensitive({ items: { type: "string" } })).toEqual([]);
    expect(dialectSensitive({ additionalItems: false })).toHaveLength(1);
    expect(dialectSensitive({ dependencies: { a: ["b"] } })).toHaveLength(1);
    expect(dialectSensitive({ $ref: "#/x", minimum: 1 })).toHaveLength(1);
    // A bare pointer, and one carrying only an annotation, are both fine.
    expect(dialectSensitive({ $ref: "#/x" })).toEqual([]);
    expect(dialectSensitive({ $ref: "#/x", description: "d" })).toEqual([]);
    // And it recurses, so a construct buried in a real schema is reachable.
    expect(
      dialectSensitive({ properties: { a: { type: "array", items: [{ type: "string" }] } } }),
    ).toHaveLength(1);
  });
});

describe("stripSchemaDialect", () => {
  it("removes $schema at every depth and leaves everything else alone", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        a: { type: "string", description: "keep me" },
        b: { $schema: "http://json-schema.org/draft-07/schema#", type: "number" },
      },
      required: ["a"],
      anyOf: [{ $schema: "x", const: 1 }],
    };
    expect(stripSchemaDialect(input)).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: "keep me" },
        b: { type: "number" },
      },
      required: ["a"],
      anyOf: [{ const: 1 }],
    });
    // Non-mutating: the SDK holds the converted object, and mutating it in
    // place would be invisible here but real for any other reader.
    expect(input.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("passes a non-tools result through untouched", () => {
    const result = { nextCursor: "abc" };
    expect(stripToolSchemaDialects(result)).toBe(result);
  });

  it("leaves a tool's other fields alone", () => {
    const result = {
      tools: [
        {
          name: "t",
          title: "T",
          annotations: { readOnlyHint: true },
          _meta: { x: 1 },
          inputSchema: { $schema: "draft-07", type: "object" },
        },
      ],
    };
    expect(stripToolSchemaDialects(result)).toEqual({
      tools: [
        {
          name: "t",
          title: "T",
          annotations: { readOnlyHint: true },
          _meta: { x: 1 },
          inputSchema: { type: "object" },
        },
      ],
    });
  });
});

describe("installSchemaDialectStrip reports drift instead of throwing", () => {
  it("returns false and logs when there is no tools/list handler to wrap", () => {
    // The hazard: an SDK bump that moves the handler map, or a factory that
    // installs the strip before registering any tool. It must be loud, but not
    // fatal — throwing here propagates out of `createMcpServer` through
    // `startMcpServerHttp` to `process.exit(1)`, taking the editor, Hocuspocus
    // and all document access with it, to avoid a degradation in which 25 tools
    // and the whole app kept working.
    const empty = new McpServer({ name: "empty", version: "0.0.1" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(installSchemaDialectStrip(empty)).toBe(false);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("tools/list handler to wrap"));
    } finally {
      spy.mockRestore();
    }
  });

  it("returns true once tools are registered, and is idempotent", () => {
    const server = new McpServer({ name: "s", version: "0.0.1" });
    server.registerTool(
      "probe",
      { description: "d", inputSchema: { a: z.string() } },
      async () => ({ content: [] }),
    );
    expect(installSchemaDialectStrip(server)).toBe(true);
    // Double-installing strips an already-stripped result, which is a no-op —
    // pinned so the claim in the doc comment is not just an assertion.
    expect(installSchemaDialectStrip(server)).toBe(true);
  });
});
