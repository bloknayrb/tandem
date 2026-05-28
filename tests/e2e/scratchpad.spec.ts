/**
 * E2E tests for the ephemeral scratchpad feature (#475).
 *
 * A scratchpad is an in-memory document with no file on disk. It appears in
 * the tab bar as "Scratchpad.md", is writable, and its content is gone after
 * the tab is closed. It must not appear in recent files or be session-restored.
 *
 * The scratchpad can be opened via:
 * - The command palette "New Scratchpad" action (Ctrl+Shift+P → type scratchpad)
 * - POST /api/scratchpad directly
 *
 * Tests use the API endpoint directly where possible to avoid palette
 * interaction overhead.
 */

import { expect, test } from "@playwright/test";
import path from "path";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

const API_BASE = `http://127.0.0.1:${DEFAULT_MCP_PORT}/api`;

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  });
});

test.afterEach(async ({ page }) => {
  // Clear scratchpad recovery data so tests never bleed content into each other.
  try {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("tandem:scratchpad:")) localStorage.removeItem(key);
      }
    });
  } catch {
    // Page may not be navigated yet if the test failed during setup.
  }
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

// ---------------------------------------------------------------------------
// API-level: POST /api/scratchpad
// ---------------------------------------------------------------------------

test("POST /api/scratchpad opens a scratchpad document", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  const result = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );

  expect(result.data).toBeDefined();
  expect(result.data.fileName).toBe("Scratchpad.md");
  expect(result.data.format).toBe("md");
  expect(result.data.readOnly).toBe(false);
  expect(result.data.source).toBe("upload");
  expect(result.data.filePath).toContain("upload://scratchpad/");
});

test("scratchpad tab appears in UI after opening", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );

  // Tab showing "Scratchpad.md" should appear
  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Persistence: close → recovery data in localStorage → new scratchpad restores
// ---------------------------------------------------------------------------

test("content typed into a scratchpad is recovered in the next one", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Open first scratchpad
  const first = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const firstDocId = first.data.documentId;

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // Type content — the persistence hook debounces a localStorage write.
  const editor = page.locator(".tandem-editor");
  await editor.click();
  await page.keyboard.type("recovery content here");

  // Close via MCP: detach() flushes the pending debounce → writes to localStorage.
  await mcp.callTool("tandem_close", { documentId: firstDocId });

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).not.toBeVisible({ timeout: 5_000 });

  // Open a new scratchpad — the hook should restore the saved content.
  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // Restoration is async (waits for Hocuspocus sync); poll until text appears.
  await expect(editor).toContainText("recovery content here", { timeout: 5_000 });
});

test("new scratchpad is empty when there is no recovery data", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Open first scratchpad and type content.
  const first = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const firstDocId = first.data.documentId;

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  const editor = page.locator(".tandem-editor");
  await editor.click();
  await page.keyboard.type("should not appear in next scratchpad");

  // Close via MCP — hook flushes content to localStorage.
  await mcp.callTool("tandem_close", { documentId: firstDocId });

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).not.toBeVisible({ timeout: 5_000 });

  // Discard the recovery data (simulates the user clearing it or a clean session).
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("tandem:scratchpad:")) localStorage.removeItem(key);
    }
  });

  // Open a new scratchpad — nothing to restore.
  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // Give the sync + effect a moment; editor should stay empty.
  await page.waitForTimeout(600);
  const editorText = await editor.textContent();
  expect(editorText).not.toContain("should not appear in next scratchpad");
});

// ---------------------------------------------------------------------------
// Command palette: "New Scratchpad" action is available
// ---------------------------------------------------------------------------

test("New Scratchpad action appears in command palette", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Open the command palette (Ctrl+Shift+P)
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("[data-testid='command-palette']")).toBeVisible({ timeout: 3_000 });

  // Type to filter for scratchpad
  await page.type("[data-testid='palette-input']", "scratchpad");

  // The action item should appear
  await expect(page.locator("[data-testid='palette-item-new-scratchpad']")).toBeVisible({
    timeout: 3_000,
  });

  // Click it — should open a scratchpad tab
  await page.locator("[data-testid='palette-item-new-scratchpad']").click();

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Scratchpad is not in recent files
// ---------------------------------------------------------------------------

test("scratchpad path is not added to recent files", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Clear any existing recent files
  await page.evaluate(() => localStorage.removeItem("tandem:recent-files"));

  // Open a scratchpad
  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );

  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // Recent files should not include any upload:// paths
  const recentFiles = await page.evaluate<string[]>(() => {
    const raw = localStorage.getItem("tandem:recent-files");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  });

  expect(recentFiles.every((p) => !p.startsWith("upload://"))).toBe(true);
});
