import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_URL = `http://localhost:${DEFAULT_MCP_PORT}/mcp`;

/**
 * MCP test client using the SDK's built-in Client + StreamableHTTPClientTransport.
 */
export class McpTestClient {
  private client: Client;
  private connected = false;

  constructor() {
    this.client = new Client({ name: "tandem-e2e-test", version: "1.0.0" });
  }

  async connect(retries = 5, delayMs = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
        await this.client.connect(transport);
        this.connected = true;
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error("Not connected — call connect() first");
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const content = result.content as Array<{ type: string; text?: string }>;
      const msg = content?.find((c) => c.type === "text")?.text ?? "unknown error";
      throw new Error(`MCP tool "${name}" failed: ${msg}`);
    }
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

/** Create a temp directory and copy fixture files into it. */
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

/**
 * Switch the side panel to the Annotations tab.
 *
 * Wave 4 changed the default `primaryTab` setting to "chat", so in the
 * tabbed layout the SidePanel (which contains annotation cards) is mounted
 * but hidden via `display: none` behind the Chat tab. Any E2E test that
 * asserts `annotation-card-*` elements are VISIBLE must call this helper
 * after `page.goto("/")` — otherwise the cards exist in the DOM but
 * Playwright reports them as hidden.
 *
 * **Silent-failure warning**: because the cards are still mounted when
 * hidden, `locator(...).count()` will return a non-zero value even without
 * this helper. Tests that assert on `count` instead of `toBeVisible` will
 * pass misleadingly. Prefer `toBeVisible` for annotation-card assertions,
 * or call this helper regardless.
 *
 * In three-panel layout mode, both panels are rendered side-by-side with
 * static headers instead of tab buttons — there is no `annotations-tab`
 * testid in that mode. The helper detects this and no-ops, so tests that
 * switch layout mid-flight still work.
 */
export async function switchToAnnotationsTab(page: Page): Promise<void> {
  const tab = page.locator("[data-testid='annotations-tab']");
  // In three-panel mode the tab button does not exist — bail silently.
  if ((await tab.count()) === 0) return;
  await tab.click();
  // The display toggle is synchronous CSS; no wait needed, but we return
  // control to the caller only after the click has resolved.
}

/**
 * Close every document the server thinks is open. Safe to call in afterEach
 * even when a test opened nothing — the loop just no-ops on an empty list.
 * Swallows errors because the server may already be shutting down.
 */
export async function cleanupAllOpenDocuments(mcp: McpTestClient): Promise<void> {
  try {
    const status = (await mcp.callTool("tandem_status")) as {
      data?: { openDocuments?: Array<{ documentId: string }> };
    };
    const docs = status?.data?.openDocuments ?? [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch {
    // Server may have shut down
  }
}
