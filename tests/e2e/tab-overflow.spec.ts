import { expect, test } from "@playwright/test";
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
  tmpDir = createFixtureDir("sample.md", "sample2.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("tab renders with filename, tooltip shows full path", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for the sample.md tab by its name content
  const tabName = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  await expect(tabName).toBeVisible();

  // Tooltip should show full file path
  const title = await tabName.getAttribute("title");
  expect(title).toContain("sample.md");
  expect(title).toContain(path.sep); // Should be a full path, not just filename
});

test("tab scroll container exists", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='tab-scroll-container']");

  const container = page.locator("[data-testid='tab-scroll-container']");
  await expect(container).toBeVisible();
});

test("multiple tabs appear", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Both our test tabs should be present
  const sample1 = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample1).toBeVisible();
  await expect(sample2).toBeVisible();
});

test("keyboard reorder with Alt+Arrow swaps tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  // Wait for sample2.md tab to appear.
  const sample2Name = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2Name).toBeVisible();

  // The tab element (role='tab') owns the keyboard handler — focus must land
  // there, not on the inner [tab-name-…] span. Match the drag test pattern below.
  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });

  // Get all tab names and find sample2's position.
  const allNames = page.locator("[data-testid^='tab-name-']");
  const count = await allNames.count();
  let initialIdx = -1;
  for (let i = 0; i < count; i++) {
    const text = await allNames.nth(i).textContent();
    if (text === "sample2.md") {
      initialIdx = i;
      break;
    }
  }
  expect(initialIdx).toBeGreaterThan(0); // sample2 should not be first

  // Click the tab itself, wait for focus to land (auto-retry), then press
  // Alt+ArrowLeft. expect.poll on the post-reorder text absorbs Svelte
  // reactivity → DOM update latency without a fixed sleep.
  await sample2Tab.click();
  await expect(sample2Tab).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");

  await expect.poll(async () => allNames.nth(initialIdx - 1).textContent()).toBe("sample2.md");
});

test("mouse drag reorders tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("http://127.0.0.1:5173");

  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample1Tab = tabs.filter({ hasText: "sample.md" });
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });
  await expect(sample1Tab).toBeVisible();
  await expect(sample2Tab).toBeVisible();

  const allNames = page.locator("[data-testid^='tab-name-']");
  const initial = await allNames.allTextContents();
  const initialS1 = initial.indexOf("sample.md");
  const initialS2 = initial.indexOf("sample2.md");
  expect(initialS1).toBeGreaterThanOrEqual(0);
  expect(initialS2).toBeGreaterThanOrEqual(0);
  const initialDelta = initialS1 - initialS2;

  // Resolve the document ids of the two tabs by reading data-testid off the
  // rendered DOM (the [data-testid^='tab-name-'] descendant lives inside the
  // tab div whose own data-testid is `tab-{id}`).
  const tabIds = await page.evaluate(() => {
    const list: Record<string, string> = {};
    document.querySelectorAll<HTMLElement>("[data-testid^='tab-'][role='tab']").forEach((el) => {
      const tid = el.getAttribute("data-testid") ?? "";
      const id = tid.startsWith("tab-") ? tid.slice("tab-".length) : "";
      const name = el.querySelector("[data-testid^='tab-name-']")?.textContent ?? "";
      if (id && name) list[name] = id;
    });
    return list;
  });
  const s1Id = tabIds["sample.md"];
  const s2Id = tabIds["sample2.md"];
  expect(s1Id).toBeTruthy();
  expect(s2Id).toBeTruthy();

  // Drag the later-positioned tab onto the earlier one — their relative order should flip.
  // Playwright's locator.dragTo synthesizes mouse events on Chromium and does NOT fire
  // HTML5 dragstart/dragover/drop, which are what DocumentTabs.svelte listens to. Dispatch
  // real DragEvents via page.evaluate instead. Chromium ignores `dataTransfer` in the
  // DragEvent init dict, so build a generic Event and assign dataTransfer via defineProperty.
  // See docs/lessons-learned.md (Playwright dragTo vs HTML5 DnD).
  const [fromId, toId] = initialS1 < initialS2 ? [s2Id, s1Id] : [s1Id, s2Id];
  await page.evaluate(
    ({ fromSel, toSel }) => {
      const from = document.querySelector<HTMLElement>(fromSel);
      const to = document.querySelector<HTMLElement>(toSel);
      if (!from || !to) throw new Error(`tabs not found: from=${!!from} to=${!!to}`);
      const rect = to.getBoundingClientRect();
      // Drop on the LEFT half so handleDragOver picks side: "left".
      const clientX = rect.left + 5;
      const clientY = rect.top + rect.height / 2;
      const store: Record<string, string> = {};
      const dt = {
        setData: (k: string, v: string) => {
          store[k] = v;
        },
        getData: (k: string) => store[k] ?? "",
        effectAllowed: "move",
        dropEffect: "move",
      } as unknown as DataTransfer;
      const fire = (el: HTMLElement, type: string) => {
        const evt = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
        Object.defineProperty(evt, "dataTransfer", { value: dt, configurable: true });
        Object.defineProperty(evt, "clientX", { value: clientX, configurable: true });
        Object.defineProperty(evt, "clientY", { value: clientY, configurable: true });
        el.dispatchEvent(evt);
      };
      fire(from, "dragstart");
      fire(to, "dragover");
      fire(to, "drop");
      fire(from, "dragend");
    },
    { fromSel: `[data-testid="tab-${fromId}"]`, toSel: `[data-testid="tab-${toId}"]` },
  );

  // Assert the signed index delta flipped sign. Robust to extra tabs from session restore.
  await expect
    .poll(async () => {
      const names = await allNames.allTextContents();
      return Math.sign(names.indexOf("sample.md") - names.indexOf("sample2.md"));
    })
    .toBe(-Math.sign(initialDelta));
});

test("open file button is always visible", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
  await page.waitForSelector("[data-testid='open-file-btn']");

  const openBtn = page.locator("[data-testid='open-file-btn']");
  await expect(openBtn).toBeVisible();
});
