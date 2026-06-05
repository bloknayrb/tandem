import { expect, type Page, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  nextFrames,
} from "./helpers";

// Inline tab rename (#1017): F2 / double-click the tab name → edit in place →
// Enter commits. The documentId/room stays stable; only the on-disk path and
// the tab label migrate. These tests drive the real UI affordance and assert
// BOTH the label update and the on-disk file move.

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function openEditor(page: Page): Promise<string> {
  // Clean slate on the reused dev server: closing the last doc can leave the
  // server on an empty-state Scratchpad, and stale tabs from a prior repeat-each
  // iteration would otherwise linger. Resolve the tab id from tandem_open's
  // OWN return (not activeDocumentId) so a stray tab can't misdirect the test,
  // and switch to it so F2 (which renames the ACTIVE tab) targets sample.md.
  await cleanupAllOpenDocuments(mcp);
  const opened = (await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  })) as { data: { documentId: string } };
  const id = opened.data.documentId;
  await mcp.callTool("tandem_switchDocument", { documentId: id });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  // Wait for the tab to render AND let the document-list broadcast reconciles
  // flush before interacting — a second reconcile arriving mid-double-click can
  // re-render the tab node between the two clicks, so the browser never sees a
  // dblclick (the two clicks register as separate single clicks → no rename).
  // `networkidle` is unusable here: Tandem holds a persistent Hocuspocus WS + SSE
  // notify-stream, so the network never goes idle. A few rAFs flush pending
  // Svelte effects (the repo's standard settle helper).
  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toBeVisible();
  await nextFrames(page, 3);
  return id;
}

// Retry the double-click until rename mode engages, returning the input locator.
// Under CPU load a tab re-render between the two synthesized clicks can make the
// browser register them as separate single clicks (no dblclick) — a real user
// simply double-clicks again, which is what toPass models.
async function startRenameByDblClick(page: Page, id: string) {
  const tabName = page.locator(`[data-testid='tab-name-${id}']`);
  const input = page.locator(`[data-testid='tab-rename-input-${id}']`);
  await expect(async () => {
    await tabName.dblclick();
    await expect(input).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return input;
}

test("double-click the tab name to rename: tab label + on-disk file both update", async ({
  page,
}) => {
  const id = await openEditor(page);
  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toHaveText("sample.md");

  const input = await startRenameByDblClick(page, id);
  await input.fill("renamed.md");
  await input.press("Enter");

  // The documentId is stable, so the tab testid persists; only the label changes.
  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toHaveText("renamed.md");

  // On disk: old gone, new present.
  await expect.poll(() => fs.existsSync(path.join(tmpDir, "renamed.md"))).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, "sample.md"))).toBe(false);
});

test("F2 renames the active tab", async ({ page }) => {
  const id = await openEditor(page);
  // F2 is a fixed shortcut; shouldIgnoreShortcut allows it even with the caret
  // in the (contenteditable) editor, so a bare page-level press reaches it.
  await page.keyboard.press("F2");
  const input = page.locator(`[data-testid='tab-rename-input-${id}']`);
  await expect(input).toBeVisible();
  await input.fill("via-f2.md");
  await input.press("Enter");

  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toHaveText("via-f2.md");
  await expect.poll(() => fs.existsSync(path.join(tmpDir, "via-f2.md"))).toBe(true);
});

test("Escape cancels the rename, leaving the label and file unchanged", async ({ page }) => {
  const id = await openEditor(page);
  const input = await startRenameByDblClick(page, id);
  await input.fill("should-not-apply.md");
  await input.press("Escape");

  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toHaveText("sample.md");
  expect(fs.existsSync(path.join(tmpDir, "sample.md"))).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, "should-not-apply.md"))).toBe(false);
});

test("an invalid name is rejected by the server and the label reverts", async ({ page }) => {
  const id = await openEditor(page);
  const input = await startRenameByDblClick(page, id);
  // ':' is the NTFS alternate-data-stream vector — server returns INVALID_NAME.
  await input.fill("a:b.md");
  await input.press("Enter");

  // The optimistic label reverts to server truth; no stray file is written.
  await expect(page.locator(`[data-testid='tab-name-${id}']`)).toHaveText("sample.md");
  expect(fs.existsSync(path.join(tmpDir, "sample.md"))).toBe(true);
});

test("tandem_rename MCP tool renames the active document (no UI)", async () => {
  // MCP-first coverage (ADR-038): the same renameDocument path the UI route
  // calls, exercised directly through the tool. No `page` — this is a pure
  // MCP probe asserting the tool result, the on-disk move, and that
  // tandem_listDocuments reflects the new path under the SAME documentId.
  await cleanupAllOpenDocuments(mcp);
  const opened = (await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  })) as { data: { documentId: string } };
  const id = opened.data.documentId;
  await mcp.callTool("tandem_switchDocument", { documentId: id });

  const result = (await mcp.callTool("tandem_rename", { newName: "mcp-renamed.md" })) as {
    error: false;
    data: { renamed: boolean; from: string; to: string; fileName: string };
  };
  expect(result.error).toBe(false);
  expect(result.data.renamed).toBe(true);
  expect(result.data.fileName).toBe("mcp-renamed.md");

  // On disk: old gone, new present.
  expect(fs.existsSync(path.join(tmpDir, "mcp-renamed.md"))).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, "sample.md"))).toBe(false);

  // The documentId/room is stable; only the path/label migrate.
  const list = (await mcp.callTool("tandem_listDocuments")) as {
    data: { documents: Array<{ id: string; fileName: string; filePath: string }> };
  };
  const entry = list.data.documents.find((d) => d.id === id);
  expect(entry?.fileName).toBe("mcp-renamed.md");
  expect(entry?.filePath).toBe(path.join(tmpDir, "mcp-renamed.md"));
});
