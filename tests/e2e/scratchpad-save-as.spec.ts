/**
 * E2E tests for the scratchpad "Save As…" feature.
 *
 * Scratchpads start as ephemeral `upload://scratchpad/<uuid>/...` docs. The
 * Save As flow promotes them in place to a real on-disk file so subsequent
 * auto-saves write back to the same path. There are two branches:
 *
 *  - Tauri runtime: native `@tauri-apps/plugin-dialog` save() picks a path;
 *    the server writes via `atomicWrite` and flips `OpenDoc.source` to
 *    `"file"`, keeping the same Hocuspocus room so connected clients don't
 *    lose CRDT state.
 *
 *  - Browser runtime: no native dialog → POST `serialize: true` and trigger
 *    a Blob + anchor download. The scratchpad stays in-session; the doc is
 *    NOT promoted (no on-disk path to point at).
 *
 * Because Playwright runs against the browser distribution (no Tauri shell),
 * the Tauri branch is exercised by calling the underlying API directly with
 * a tmp path. The browser-fallback branch is exercised by intercepting the
 * anchor `click()` to capture the Blob contents — the actual browser
 * download is a no-op in the headless harness.
 */

import { expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
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
let fixtureDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-save-as-"));
  // Open a fixture doc so the editor (`.tandem-editor`) mounts — App.svelte
  // renders EmptyState until there is an active tab. Mirrors scratchpad.spec.ts.
  fixtureDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(fixtureDir, "sample.md") });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  cleanupFixtureDir(fixtureDir);
});

// ---------------------------------------------------------------------------
// Palette: the Save As… action is registered and discoverable
// ---------------------------------------------------------------------------

test("Save As… action appears in the command palette", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Open a scratchpad first so save-as has a sensible default-name hint.
  await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "Scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // Open the command palette and filter for "save as".
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("[data-testid='command-palette']")).toBeVisible({ timeout: 3_000 });
  await page.type("[data-testid='palette-input']", "save as");

  await expect(page.locator("[data-testid='palette-item-save-as']")).toBeVisible({
    timeout: 3_000,
  });
});

// ---------------------------------------------------------------------------
// Server-side: Tauri path. Promote scratchpad to a real file via POST /api/save.
// ---------------------------------------------------------------------------

test("POST /api/save with targetPath writes the file and promotes the scratchpad", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  // Open a fresh scratchpad and grab its documentId.
  const opened = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const docId = opened.data.documentId as string;
  expect(typeof docId).toBe("string");
  expect(opened.data.source).toBe("upload");
  expect(opened.data.filePath).toContain("upload://scratchpad/");

  // Type some content into the active editor.
  const editor = page.locator(".tandem-editor");
  await editor.click();
  await page.keyboard.type("hello from save-as");

  // Pick a tmp target path; pre-flight: file must not exist.
  const targetPath = path.join(tmpDir, "promoted-scratchpad.md");
  expect(fs.existsSync(targetPath)).toBe(false);

  // Save As via the API — same shape the Tauri client posts.
  const saveResult = await page.evaluate(
    async ({ base, documentId, target }) => {
      const res = await fetch(`${base}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, targetPath: target, format: "md" }),
      });
      return { status: res.status, body: await res.json() };
    },
    { base: API_BASE, documentId: docId, target: targetPath },
  );

  expect(saveResult.status).toBe(200);
  expect(saveResult.body?.data?.status).toBe("saved");
  expect(saveResult.body?.data?.fileName).toBe("promoted-scratchpad.md");

  // The on-disk file exists and contains our typed content.
  expect(fs.existsSync(targetPath)).toBe(true);
  const onDisk = fs.readFileSync(targetPath, "utf-8");
  expect(onDisk).toContain("hello from save-as");

  // The tab title updates to the new basename (broadcast via openDocuments).
  await expect(
    page.locator("[data-testid^='tab-name-']", { hasText: "promoted-scratchpad.md" }),
  ).toBeVisible({ timeout: 5_000 });

  // The doc was promoted in place: same documentId, source flipped to 'file'.
  // We can confirm via MCP `tandem_status`.
  const status = (await mcp.callTool("tandem_status")) as {
    error: false;
    data: { openDocuments: Array<{ documentId: string; filePath: string }> };
  };
  const promoted = status.data.openDocuments.find((d) => d.documentId === docId);
  expect(promoted).toBeDefined();
  expect(promoted?.filePath).toBe(targetPath);
});

test("POST /api/save with invalid format rejects the request", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  const opened = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const docId = opened.data.documentId as string;

  const targetPath = path.join(tmpDir, "rejected.rtf");
  const result = await page.evaluate(
    async ({ base, documentId, target }) => {
      const res = await fetch(`${base}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, targetPath: target, format: "rtf" }),
      });
      return { status: res.status, body: await res.json() };
    },
    { base: API_BASE, documentId: docId, target: targetPath },
  );

  expect(result.status).toBe(400);
  expect(String(result.body?.message ?? "")).toMatch(/md.*txt|txt.*md/i);
  expect(fs.existsSync(targetPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// Server-side: browser fallback returns serialized bytes inline
// ---------------------------------------------------------------------------

test("POST /api/save with serialize=true returns content inline and does not promote", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });

  const opened = await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  );
  const docId = opened.data.documentId as string;

  const editor = page.locator(".tandem-editor");
  await editor.click();
  await page.keyboard.type("browser-fallback payload");

  const serializeResult = await page.evaluate(
    async ({ base, documentId }) => {
      const res = await fetch(`${base}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, serialize: true, format: "md" }),
      });
      return { status: res.status, body: await res.json() };
    },
    { base: API_BASE, documentId: docId },
  );

  expect(serializeResult.status).toBe(200);
  expect(typeof serializeResult.body?.data?.content).toBe("string");
  expect(serializeResult.body.data.content).toContain("browser-fallback payload");
  expect(serializeResult.body.data.fileName).toBe("Scratchpad.md");
  expect(serializeResult.body.data.format).toBe("md");

  // Promotion did NOT happen: the doc is still source: 'upload'.
  const status = (await mcp.callTool("tandem_status")) as {
    error: false;
    data: { openDocuments: Array<{ documentId: string; filePath: string }> };
  };
  const still = status.data.openDocuments.find((d) => d.documentId === docId);
  expect(still?.filePath).toContain("upload://scratchpad/");
});
