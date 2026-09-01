import { expect, type Page, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import type { ToolResponse } from "../../src/shared/types.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
} from "./helpers";

const API_BASE = `http://127.0.0.1:${E2E_MCP_PORT}/api`;

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

async function openSample(page: Page) {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  return editor;
}

test("slash menu opens and Enter applies the selected command", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /h2");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Heading 2" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.locator(".tiptap h2").first()).toContainText("first paragraph");
});

test("slash menu supports arrow-key selection", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();

  // Two presses, not one: the unfiltered list is [paragraph, heading-1,
  // heading-2, ...], so index 2 is heading-2. This assertion is positional and
  // therefore fragile by nature — it broke silently when Paragraph was inserted
  // at index 0. If it fails again after a command is added, check the array
  // order in `slash-menu/commands.ts` before assuming the menu is broken.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(menu).toBeHidden();
  await expect(page.locator(".tiptap h2").first()).toContainText("first paragraph");
});

test("slash menu supports pointer selection", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /quote");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: "Quote" }).dispatchEvent("mousedown");

  await expect(menu).toBeHidden();
  await expect(page.locator(".tiptap blockquote").first()).toContainText("first paragraph");
});

test("slash menu cancels with Escape and deletion", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.keyboard.press("Backspace");
  await page.keyboard.type(" /");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(menu).toBeHidden();
});

test("slash menu inserts Heading 3", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /h3");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Heading 3" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.locator(".tiptap h3").first()).toContainText("first paragraph");
});

test("slash menu inserts horizontal rule", async ({ page }) => {
  await openSample(page);

  await page.keyboard.type(" /hr");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Horizontal rule" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.locator(".tiptap hr").first()).toBeVisible();
});

test("slash menu inserts a fixed 3x3 table and round-trips through save/reload (#995)", async ({
  page,
}) => {
  await openSample(page);

  await page.keyboard.type(" /table");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "Table" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();

  // 1 header row + 2 body rows, 3 columns each -- fixed dimensions, no
  // alignment/row-col ops/header-toggle/merge (deferred scope, #995).
  const table = page.locator(".tiptap table").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(3);

  // Save, then re-open with force:true to reload strictly from the on-disk
  // markdown (remark-gfm round-trip, already covered at the unit level by
  // mdast-ydoc.test.ts) and confirm the table survives serialize -> reparse.
  // This assertion was `expect(saveResult.isError).toBeFalsy()`, which could
  // never fail. `McpTestClient.callTool` THROWS when the MCP result carries
  // `isError` (helpers.ts:71-75) and otherwise returns the parsed JSON payload,
  // so the returned object has no `isError` property at all -- the expectation
  // read `undefined` and passed unconditionally. Typechecking the test tree is
  // what surfaced it. `error` is the discriminant the payload actually carries.
  const saveResult = (await mcp.callTool("tandem_save", {})) as ToolResponse<unknown>;
  expect(saveResult.error).toBe(false);
  const savedPath = path.join(tmpDir, "sample.md");
  const onDisk = fs.readFileSync(savedPath, "utf-8");
  expect(onDisk).toMatch(/\|.*\|.*\|.*\|/);
  expect(onDisk).toMatch(/\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/); // GFM header separator row

  await mcp.callTool("tandem_open", { filePath: savedPath, force: true });
  const reloadedTable = page.locator(".tiptap table").first();
  await expect(reloadedTable).toBeVisible();
  await expect(reloadedTable.locator("tr")).toHaveCount(3);
});

test("slash menu inserts a table in an ephemeral scratchpad (#995)", async ({ page }) => {
  // Scratchpads have no on-disk file (upload://scratchpad/...), so this
  // exercises table insertion on that path independent of the save/reload
  // round-trip covered above.
  await page.goto("/");
  await page.waitForSelector(".tandem-editor", { timeout: 10_000 });
  // Scope to the documentId this call returns, not to the tab's TEXT. Every
  // scratchpad is titled "Scratchpad.md", the server outlives a Playwright
  // retry, and a retry POSTs a second one — so a hasText locator resolves to
  // two tabs and fails strict mode on the retry rather than on the defect.
  const created = (await page.evaluate(
    (base) => fetch(`${base}/scratchpad`, { method: "POST" }).then((r) => r.json()),
    API_BASE,
  )) as { data: { documentId: string } };
  await expect(page.getByTestId(`tab-name-${created.data.documentId}`)).toBeVisible({
    timeout: 5_000,
  });

  // Only the active document's editor is mounted, and the POST above made the
  // new scratchpad active — but scope to the last match anyway so a lingering
  // tab from an earlier test cannot make this ambiguous.
  const editor = page.locator(".tiptap").last();
  await editor.click();
  await page.keyboard.type("/table");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();

  const table = editor.locator("table").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);

  // Clear scratchpad recovery data so this doesn't leak into other tests.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("tandem:scratchpad:")) localStorage.removeItem(key);
    }
  });
});

test("slash menu suppresses while annotation popup is open (D10)", async ({ page }) => {
  const editor = await openSample(page);

  // Select text to open the selection toolbar. Wave M (PR #776) split the
  // popup: selection shows the action surface (Annotate button + highlight
  // swatches); clicking Annotate reveals `popup-annotation-input`. The slash
  // menu must refuse to activate while either surface is mounted (D10
  // forward suppression). We exercise the annotate-mode arm here because the
  // test focuses the textarea below.
  const paragraph = editor.locator("p").first();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error("paragraph not laid out");
  await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 3 });

  await openAnnotatePopup(page);
  const popupInput = page.getByTestId("popup-annotation-input");
  await popupInput.focus();

  const slashMenu = page.getByRole("listbox", { name: "Slash commands" });
  await page.keyboard.type("/");
  await expect(slashMenu).toBeHidden();
});
