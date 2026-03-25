import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";
import path from "path";
import os from "os";

const MCP_URL = "http://localhost:3479/mcp";

/**
 * MCP test client using the SDK's built-in Client + StreamableHTTPClientTransport.
 * Handles initialize, session tracking, and tool calls.
 */
export class McpTestClient {
  private client: Client;
  private connected = false;

  constructor() {
    this.client = new Client({ name: "tandem-e2e-test", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    await this.client.connect(transport);
    this.connected = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error("Not connected — call connect() first");
    const result = await this.client.callTool({ name, arguments: args });
    // MCP tool results have content array; parse the first text item
    const content = result.content as Array<{ type: string; text?: string }>;
    const textItem = content?.find((c) => c.type === "text");
    if (textItem?.text) {
      try {
        return JSON.parse(textItem.text);
      } catch {
        return textItem.text;
      }
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

/**
 * Create a temp directory and copy fixture files into it.
 * Returns the temp dir path. Caller is responsible for cleanup.
 */
export function createFixtureDir(...fixtureNames: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-"));
  const fixturesDir = path.join(__dirname, "fixtures");
  for (const name of fixtureNames) {
    fs.copyFileSync(path.join(fixturesDir, name), path.join(tmpDir, name));
  }
  return tmpDir;
}

/** Clean up a temp directory. */
export function cleanupFixtureDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}
