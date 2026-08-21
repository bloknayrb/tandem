import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * Keyboard-only operability (v1.0 gate criterion A5).
 *
 * Retries are disabled for this file. The global config retries once, which is
 * fine for a deterministic axe scan but wrong here: a genuinely broken focus
 * trap that fails on the first attempt and passes on the second reports green,
 * and these assertions run against 200-260ms modal entrance animations that
 * make exactly that flake plausible.
 */
// The timeout is raised (not the retry count) because the first test in the
// file pays for Vite's cold module compile, which alone can exceed the default
// 30s. Retries would paper over that AND over the real flake this file is
// guarding against; a longer budget only addresses the former.
test.describe.configure({ retries: 0, timeout: 90_000 });

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 15_000 });
}

/** A stable description of whatever currently holds focus. */
async function focusId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "<none>";
    return (
      el.getAttribute("data-testid") ??
      el.getAttribute("aria-label") ??
      `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}`
    );
  });
}

// ---------------------------------------------------------------------------
// Composite widgets: arrow-key operability
// ---------------------------------------------------------------------------
// The row neither axe nor a Tab-only traversal can cover. axe checks structure
// and cannot see that a `keydown` handler has no `ArrowDown` branch; a Tab walk
// passes because the items are buttons and therefore tabbable. Per the WAI-ARIA
// APG, a `role="menu"` is a composite widget: it takes ONE tab stop and arrow
// keys move between its items.
//
// `CommandPalette` implements this correctly (arrow keys + aria-activedescendant),
// which is the positive control that the pattern is understood in this codebase.

const MENUS = [
  {
    name: "brand menu",
    open: async (page: Page) => {
      await page.locator("[data-testid='titlebar-brand-menu']").click();
      await expect(page.locator("[data-testid='titlebar-brand-menu-popover']")).toBeVisible({
        timeout: 5_000,
      });
    },
    // The popover element itself carries role="menu".
    menu: "[data-testid='titlebar-brand-menu-popover']",
  },
  {
    name: "heading menu",
    open: async (page: Page) => {
      await page.locator(".tiptap").click();
      await page.locator("[data-testid='formatting-bar'] button[aria-label^='Heading']").click();
      await expect(page.locator("[role='menu'][aria-label='Heading level']")).toBeVisible({
        timeout: 5_000,
      });
    },
    menu: "[role='menu'][aria-label='Heading level']",
  },
  {
    name: "decorations menu",
    open: async (page: Page) => {
      await page.getByTestId("decorations-menu-caret").click();
      await expect(page.locator("[data-testid='decorations-menu']")).toBeVisible({
        timeout: 5_000,
      });
    },
    menu: "[data-testid='decorations-menu'] [role='menu']",
  },
];

for (const m of MENUS) {
  test(`${m.name}: arrow keys move focus between items`, async ({ page }) => {
    await boot(page);
    await m.open(page);

    const items = page.locator(`${m.menu} [role^='menuitem']`);
    const count = await items.count();
    expect(count, `${m.name} should expose menu items`).toBeGreaterThan(1);

    // Deliberately NO manual `items.first().focus()` here.
    //
    // An earlier revision of this test did exactly that, and it was measuring
    // the one state in which the code already worked. Opening a menu does not
    // by itself put focus inside it — focus stays on the trigger, which is a
    // SIBLING of the `role="menu"` element, so the menu's keydown handler never
    // sees the key at all. Pre-focusing an item skipped straight past that and
    // reported a pass on a menu whose very first arrow press did nothing.
    //
    // So: open it the way a user does, and press the key the way a user does.
    const insideMenu = () =>
      page
        .locator(`${m.menu} [role^='menuitem']:focus`)
        .count()
        .then((n) => n > 0);

    expect(await insideMenu(), `${m.name} should place focus on an item when it opens`).toBe(true);
    const first = await focusId(page);

    await page.keyboard.press("ArrowDown");
    expect(await insideMenu(), `ArrowDown left ${m.name}`).toBe(true);
    const afterDown = await focusId(page);
    expect(afterDown, `ArrowDown must move focus within ${m.name}`).not.toBe(first);

    await page.keyboard.press("ArrowUp");
    const afterUp = await focusId(page);
    expect(afterUp, `ArrowUp must return focus within ${m.name}`).toBe(first);
  });
}

// ---------------------------------------------------------------------------
// Focus visibility
// ---------------------------------------------------------------------------

test("keyboard focus is visibly indicated, not just moved", async ({ page }) => {
  await boot(page);

  // Walk a handful of stops from the top of the document.
  const invisible: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
        s.boxShadow !== "none" ||
        parseFloat(s.borderWidth || "0") > 0;
      return {
        id: el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.tagName,
        ring,
      };
    });
    // `null` means focus is on <body> — nothing to assert about.
    if (info && !info.ring) invisible.push(info.id);
  }

  expect(invisible, "focused elements with no visible focus indicator").toEqual([]);
});

// ---------------------------------------------------------------------------
// No positive tabindex anywhere
// ---------------------------------------------------------------------------
// A positive tabindex reorders the whole document's tab sequence, not just its
// own element — the classic way a keyboard order silently stops matching the
// visual one.

test("no element uses a positive tabindex", async ({ page }) => {
  await boot(page);
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[tabindex]"))
      .filter((el) => Number(el.getAttribute("tabindex")) > 0)
      .map((el) => `${el.tagName.toLowerCase()}[tabindex="${el.getAttribute("tabindex")}"]`),
  );
  expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------
// Modal behaviour: Escape closes, and focus goes back where it came from
// ---------------------------------------------------------------------------

test("command palette returns focus to the editor on Escape", async ({ page }) => {
  await boot(page);

  await page.locator(".tiptap").click();
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("[data-testid='command-palette']")).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='command-palette']")).toBeHidden({ timeout: 5_000 });

  // Focus must land somewhere real — not stranded on <body>, which leaves a
  // keyboard user starting their next Tab from the top of the document.
  const parked = await page.evaluate(() => document.activeElement === document.body);
  expect(parked, "focus was stranded on <body> after closing the palette").toBe(false);
});

test("brand menu returns focus to its trigger when dismissed from outside", async ({ page }) => {
  await boot(page);

  await page.locator("[data-testid='titlebar-brand-menu']").click();
  await expect(page.locator("[data-testid='titlebar-brand-menu-popover']")).toBeVisible({
    timeout: 5_000,
  });
  // Opening moves focus onto a menu item — the element that is about to unmount.
  expect(await focusId(page), "opening the menu should put focus inside it").not.toBe("<none>");

  // A mousedown on a NON-focusable region. This is the case that strands focus:
  // the browser performs no focus transfer of its own, so if the close path does
  // not restore, `activeElement` falls to <body> and the user's next Tab
  // restarts from the top of the document. Dispatched rather than clicked so the
  // target is guaranteed non-focusable regardless of layout.
  await page.evaluate(() => {
    document.documentElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await expect(page.locator("[data-testid='titlebar-brand-menu-popover']")).toBeHidden({
    timeout: 5_000,
  });

  const parked = await page.evaluate(() => document.activeElement === document.body);
  expect(parked, "focus was stranded on <body> after an outside dismiss").toBe(false);
  expect(await focusId(page)).toBe("titlebar-brand-menu");
});

// ---------------------------------------------------------------------------
// Selected-ness of the rail's panel switcher (#1452)
// ---------------------------------------------------------------------------

/**
 * Which rail panel you are on was conveyed by an `on` class and nothing else, so
 * a screen reader announced two identically-shaped buttons. `aria-current` is the
 * signal; this asserts it TRACKS the selection rather than merely existing.
 *
 * Both halves are load-bearing and neither implies the other: a hard-coded
 * attribute passes the "active tab has it" check forever, and an attribute that
 * is never set passes the "inactive tab lacks it" check forever. Asserting the
 * pair on both tabs, before and after a switch, is what pins the binding.
 *
 * This deliberately does NOT assert `role="tab"`. The switcher follows the
 * Settings sidebar's plain-button + `aria-current` shape; adopting the APG tabs
 * pattern would oblige a roving tabindex, which is a keyboard behaviour change.
 * If that is ever adopted, this test SHOULD fail and be rewritten — it is
 * pinning the current contract, not forbidding a better one.
 */
test("the rail's panel switcher exposes which panel is selected", async ({ page }) => {
  await boot(page);

  const annotations = page.locator("[data-testid='annotations-tab']");
  const chat = page.locator("[data-testid='chat-tab']");

  // Three-panel layout renders both panels side by side with static headers and
  // no tab buttons at all (see `switchToAnnotationsTab` in helpers.ts). Skip
  // rather than fail, so a layout-mode default change does not read as an a11y
  // regression.
  if ((await annotations.count()) === 0) {
    test.skip(true, "tabbed rail layout is not active; there is no switcher to assert on");
  }

  await expect(annotations).toBeVisible({ timeout: 5_000 });
  await expect(chat).toBeVisible({ timeout: 5_000 });

  // Which tab starts active follows the user's `primaryTab` setting, so this
  // asserts the INVARIANT (exactly one is marked) rather than naming a winner.
  // Both failure modes it catches are real: nothing marked leaves a screen
  // reader with no selection at all, and both marked is worse than neither.
  const marked = async () =>
    await page
      .locator(
        "[data-testid='annotations-tab'][aria-current], [data-testid='chat-tab'][aria-current]",
      )
      .count();
  expect(await marked(), "exactly one rail tab should be marked current").toBe(1);

  await chat.click();
  await expect(page.locator("[data-testid='chat-panel']")).toBeVisible({ timeout: 5_000 });
  await expect(chat).toHaveAttribute("aria-current", "page");
  await expect(annotations).not.toHaveAttribute("aria-current", /.*/);

  // And back — a one-way binding would survive everything above.
  await annotations.click();
  await expect(annotations).toHaveAttribute("aria-current", "page");
  await expect(chat).not.toHaveAttribute("aria-current", /.*/);
});
