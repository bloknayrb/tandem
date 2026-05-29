import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import type { ToolResponse } from "../../src/shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`;

/**
 * Annotation dir used by the E2E test server (mirrors TANDEM_APP_DATA_DIR in
 * playwright.config.ts webServer.env). Used to clean up orphaned envelopes in
 * cleanupFixtureDir so the rename-recovery feature (#313) doesn't mistake a
 * deleted fixture path as a rename signal for the next test's identical fixture.
 */
const E2E_ANNOTATIONS_DIR = path.join(
  process.env.TANDEM_APP_DATA_DIR ?? "/tmp/tandem-e2e-data",
  "annotations",
);

/**
 * Compute the server's docHash for an absolute file path. Must stay in sync
 * with `src/server/annotations/doc-hash.ts#docHash`.
 */
function fixtureDocHash(filePath: string): string {
  let normalized = path.resolve(filePath);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

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

/**
 * Clean up a temp directory AND its orphaned annotation envelopes.
 *
 * The rename-recovery feature (#313) re-associates an orphaned annotation
 * envelope to a new file when: (a) the new file's content hash matches the
 * old envelope's stored hash, and (b) the old file path no longer exists. In
 * E2E tests, all tests share the same fixture content (`sample.md`), so after
 * the fixture dir is deleted the old path "vanishes" and the next test's fresh
 * fixture (identical content → same hash) satisfies both conditions — causing
 * stale annotations from a previous test to appear unexpectedly.
 *
 * Fix: delete the annotation envelopes for files in `dir` BEFORE removing the
 * dir itself, so recovery never sees the orphaned envelope.
 */
export function cleanupFixtureDir(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      try {
        fs.rmSync(path.join(E2E_ANNOTATIONS_DIR, `${fixtureDocHash(abs)}.json`), { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
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

  // FilterBar defaults to collapsed since feat(panels): collapsible filter bar
  // (PR #578). Expand it so callers can immediately interact with filter controls.
  const toggle = page.locator("[data-testid='filter-bar-toggle']");
  if ((await toggle.count()) > 0) {
    await toggle.click();
  }
}

/**
 * Open the selection popup's annotate mode. Wave M (PR #776) split the popup
 * into two surfaces — selection shows the action surface (formatting +
 * highlight swatches + Annotate button); clicking Annotate reveals the
 * textarea-bearing annotate mode (`popup-annotation-input`,
 * `popup-comment-submit`, `popup-note-submit`). Tests that interact with the
 * textarea or submit buttons must call this helper after selecting text.
 */
export async function openAnnotatePopup(page: Page): Promise<void> {
  const annotateBtn = page.locator("[data-testid='popup-annotate-btn']");
  await expect(annotateBtn).toBeVisible({ timeout: 3_000 });
  await annotateBtn.click();
  await expect(page.locator("[data-testid='popup-annotation-input']")).toBeVisible({
    timeout: 3_000,
  });
}

/**
 * Wait for `n` animation frames inside the page. Use after viewport resizes or
 * other DOM mutations that propagate through ResizeObserver → Svelte `$state` →
 * `$effect` → DOM, instead of `page.waitForTimeout(fixedMs)`.
 *
 * The full chain after `setViewportSize` is: CDP resize task → rAF #1 (e.g.
 * `useViewportWidth.svelte.ts:16-30` debounce) → microtask ($effect + $derived)
 * → rAF #2 (paint). Default `n=3` adds one frame of slack for CI load.
 */
export async function nextFrames(page: Page, n = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = () => (++i >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/**
 * Open the Settings popover via the brand-menu dropdown (Wave M: the old
 * standalone gear button was replaced by a menu item inside the Tandem logo
 * dropdown). Call this wherever tests previously clicked `[data-testid='settings-btn']`.
 */
export async function openSettingsPopover(page: Page): Promise<void> {
  await page.locator("[data-testid='titlebar-brand-menu']").click();
  await page.locator("[data-testid='brand-menu-settings']").click();
}

/** Success-payload shape for `tandem_status` consumed by `cleanupAllOpenDocuments`. */
type StatusData = {
  openDocuments?: Array<{ documentId: string }>;
};

/**
 * Close every document the server thinks is open. Safe to call in afterEach
 * even when a test opened nothing — the loop just no-ops on an empty list.
 * Swallows errors because the server may already be shutting down.
 */
export async function cleanupAllOpenDocuments(mcp: McpTestClient): Promise<void> {
  try {
    // McpTestClient.callTool throws on SDK-level errors but returns the parsed
    // envelope on success. Server errors still come through as `{ error: true, ... }`
    // in the envelope — the `error === false` narrow picks the success arm.
    const status = (await mcp.callTool("tandem_status")) as ToolResponse<StatusData>;
    const docs = status.error === false ? (status.data.openDocuments ?? []) : [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch (err) {
    // Server may be shutting down — log so genuine regressions aren't silently
    // swallowed by an afterEach hook.
    console.warn("cleanupAllOpenDocuments failed:", err);
  }
}
