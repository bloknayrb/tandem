import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

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

test("slash menu suppresses while annotation popup is open (D10)", async ({ page }) => {
  const editor = await openSample(page);

  // Select text to open the selection toolbar. The popup mounts
  // `popup-annotation-input` — the slash menu must refuse to activate while
  // that surface is present (D10 forward suppression).
  const paragraph = editor.locator("p").first();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error("paragraph not laid out");
  await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 3 });

  const popupInput = page.getByTestId("popup-annotation-input");
  await expect(popupInput).toBeVisible();
  await popupInput.focus();

  const slashMenu = page.getByRole("listbox", { name: "Slash commands" });
  await page.keyboard.type("/");
  await expect(slashMenu).toBeHidden();
});
