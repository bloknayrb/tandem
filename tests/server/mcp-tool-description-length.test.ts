/**
 * Every tool description fits Claude Code's 2,048-character cap (#2287).
 *
 * Claude Code 2.1.84–2.1.295 truncates MCP tool descriptions (and server
 * instructions) at 2,048 characters; 2.1.296 raised the up-front cap to 4,096,
 * but the older clients are still installed. A description over the cap loses
 * its tail silently — `tandem_checkInbox` lost the `selectionAt` meaning and
 * the stale-offsets warning that way. The cap is counted in characters
 * (`.length`); whether a truncation marker is appended is unknown, so the
 * budget keeps 48 characters of headroom.
 *
 * Driven over HTTP through `startMcpServerHttp`, so it measures the production
 * `tools/list` — every registrar, the `schema-dialect.ts` wrapper, and the two
 * `.docx` tools (vitest's root `test.env` sets `TANDEM_DOCX`).
 */

import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_INSTRUCTIONS } from "../../src/channel/instructions.js";
import {
  closeMcpSession,
  SERVER_INSTRUCTIONS,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { type ListedTool, listToolsOverHttp } from "../helpers/mcp-http-tools-list.js";
import { allMcpSource, registeredToolNames } from "../helpers/mcp-source.js";

/** Claude Code's cap, less headroom for a possible truncation marker. */
const BUDGET = 2048 - 48;

let httpServer: Server;
let tools: ListedTool[];

beforeAll(async () => {
  const port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
  tools = await listToolsOverHttp(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Every `description` string anywhere in a JSON schema, with its path. */
function schemaDescriptions(schema: unknown, path: string): Array<[string, string]> {
  if (typeof schema !== "object" || schema === null) return [];
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") out.push([path, value]);
    else out.push(...schemaDescriptions(value, `${path}.${key}`));
  }
  return out;
}

describe("tool descriptions fit Claude Code's 2,048-character cap", () => {
  it("measures every tool the source registers", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...registeredToolNames(allMcpSource())].sort(),
    );
  });

  it("every tool description", () => {
    const over = tools
      .filter((t) => (t.description ?? "").length > BUDGET)
      .map((t) => `${t.name}: ${t.description?.length} characters`);
    expect(over, `over the ${BUDGET}-character budget`).toEqual([]);
  });

  it("every input-schema description", () => {
    const over = tools.flatMap((t) =>
      schemaDescriptions(t.inputSchema, t.name)
        .filter(([, text]) => text.length > BUDGET)
        .map(([path, text]) => `${path}: ${text.length} characters`),
    );
    expect(over, `over the ${BUDGET}-character budget`).toEqual([]);
  });

  it("the server instructions and the channel shim's", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(BUDGET);
    expect(CHANNEL_INSTRUCTIONS.length).toBeLessThanOrEqual(BUDGET);
  });
});
