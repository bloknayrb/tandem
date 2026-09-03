import { expect, type Page, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openSettingsViaBrandMenu,
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
  await page.goto("/");

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
  await page.goto("/");
  await page.waitForSelector("[data-testid='tab-scroll-container']");

  const container = page.locator("[data-testid='tab-scroll-container']");
  await expect(container).toBeVisible();
});

test("multiple tabs appear", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("/");

  // Both our test tabs should be present
  const sample1 = page.locator("[data-testid^='tab-name-']", { hasText: "sample.md" });
  const sample2 = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample1).toBeVisible();
  await expect(sample2).toBeVisible();
});

test("keyboard reorder with Alt+Arrow swaps tabs", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample2.md") });
  await page.goto("/");

  // Wait for sample2.md tab to appear.
  const sample2Name = page.locator("[data-testid^='tab-name-']", { hasText: "sample2.md" });
  await expect(sample2Name).toBeVisible();

  // The tab element (role='tab') owns the keyboard handler — focus must land
  // there, not on the inner [tab-name-…] span. Match the drag test pattern below.
  const tabs = page.locator("[data-testid^='tab-'][role='tab']");
  const sample2Tab = tabs.filter({ hasText: "sample2.md" });

  // Get all tab names and find sample2's position. One round trip via
  // `allTextContents()` beats a sequential `nth(i).textContent()` loop.
  const allNames = page.locator("[data-testid^='tab-name-']");
  const initialIdx = (await allNames.allTextContents()).indexOf("sample2.md");
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
  await page.goto("/");

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
  // Reorder is now driven by POINTER events (DocumentTabs.svelte), not HTML5 DnD: in the
  // Tauri desktop app `dragDropEnabled: true` makes the WebView swallow HTML5 drag events,
  // so the production handlers listen on pointerdown/move/up. Playwright's page.mouse.*
  // synthesizes real pointer events, so a native mouse drag now exercises the real path
  // (it could not with the old HTML5 handlers — see docs/lessons-learned.md #70).
  const activeBefore = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");

  const [fromId, toId] = initialS1 < initialS2 ? [s2Id, s1Id] : [s1Id, s2Id];
  const fromBox = await page.locator(`[data-testid="tab-${fromId}"]`).boundingBox();
  const toBox = await page.locator(`[data-testid="tab-${toId}"]`).boundingBox();
  if (!fromBox || !toBox) throw new Error("tab bounding boxes not found");

  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Multi-step move guarantees pointermove events fire and the 5px threshold is crossed.
  // Drop on the LEFT half of the target so the handler picks side: "left".
  await page.mouse.move(toBox.x + 5, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.up();

  // Assert the signed index delta flipped sign. Robust to extra tabs from session restore.
  await expect
    .poll(async () => {
      const names = await allNames.allTextContents();
      return Math.sign(names.indexOf("sample.md") - names.indexOf("sample2.md"));
    })
    .toBe(-Math.sign(initialDelta));

  // The trailing click after a drag must be suppressed: the active tab should
  // not change just because we dragged a tab.
  const activeAfter = await page
    .locator('[data-testid^="tab-"][role="tab"][data-active="true"]')
    .getAttribute("data-testid");
  expect(activeAfter).toBe(activeBefore);
});

test("open file button is always visible", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await page.waitForSelector("[data-testid='open-file-btn']");

  const openBtn = page.locator("[data-testid='open-file-btn']");
  await expect(openBtn).toBeVisible();
});

/**
 * The tab strip's sizing contract (#1250, then the `uniformTabWidth` setting).
 * Three review passes agreed on a mechanism that turned out to be wrong, and
 * only measurement caught it — see lesson 85 in docs/lessons-learned.md — so
 * both modes get a real guard.
 *
 * The fixture deliberately MIXES name lengths. An earlier version opened twelve
 * near-identical names, which cannot express width dispersion: a uniformity
 * check passes trivially in both modes, so the assertion that actually
 * distinguishes them was unavailable.
 *
 * `.tab-flip` and `.title-bar-actions` are matched by class, not testid: both
 * are structural boxes owned by the components under test with no user-facing
 * identity of their own, and a testid on either would exist solely for this
 * assertion.
 */
const FLOOR_PX = 142;

/** Long names rest at the 240px name cap; the two short ones are the dispersion probe. */
const FIXTURE_NAMES = [
  ...Array.from({ length: 10 }, (_, i) => `tandem-ink-email-runbook-${i + 1}.md`),
  "ab.md",
  "notes.md",
];

async function openFixtureTabs(page: Page, uniform: boolean) {
  // `tabEnter`/`tabExit` animate `width` and inject `min-width: 0`, so a pill
  // measured mid-transition reports a collapsing box rather than its resting
  // size. Zeroing both durations makes these measurements deterministic instead
  // of merely slow. `motionOff()` reads this same media query.
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const name of FIXTURE_NAMES) {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, `# ${name}\n\nSizing fixture.\n`);
    await mcp.callTool("tandem_open", { filePath });
  }

  // Seed the setting before first paint. `schemaVersion` must be AT MOST the
  // current one: seed it lower and loadSettings migrates (fine — 18 is two
  // behind `CURRENT_SCHEMA_VERSION` today and migrates through), but seed it
  // higher and the whole run silently goes `_readOnly`. This comment used to
  // say "must be the CURRENT one", which stopped being what the code does the
  // first time the schema was bumped past 18.
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({ schemaVersion: 18, uniformTabWidth: value }),
      );
    },
    ["tandem:settings", uniform],
  );

  await page.goto("/");
  await page.waitForSelector("[data-testid='tab-scroll-container']");
  await expect
    .poll(() => page.locator(".tab-flip").count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(FIXTURE_NAMES.length);
}

async function measureTabStrip(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    const scroller = document.querySelector("[data-testid='tab-scroll-container']") as HTMLElement;
    const actions = document.querySelector(".title-bar-actions") as HTMLElement;
    return {
      overflowing: scroller.scrollWidth > scroller.clientWidth,
      scrollerClass: scroller.className,
      actions: box(actions)!,
      viewportWidth: document.documentElement.clientWidth,
      tabs: [...document.querySelectorAll<HTMLElement>(".tab-flip")].map((wrapper) => {
        const pill = wrapper.firstElementChild as HTMLElement;
        // Null while a tab is renaming — the span is swapped for an input.
        const name = pill.querySelector("[data-testid^='tab-name-']");
        // Right edge of the pill's CONTENT box, read off computed style rather
        // than restating TabItem's `padding: 0 10px 0 12px`. Reading it matters
        // for more than tidiness: the active pill's border is 1px and every
        // inactive one's is 2px (TabItem's `border-right` ternary), so a
        // hardcoded offset would be off by a pixel on exactly one tab — which
        // is the same size as the tolerance any flushness assertion needs.
        const cs = getComputedStyle(pill);
        const pillBox = box(pill)!;
        return {
          uniform: wrapper.classList.contains("uniform"),
          // The filename as rendered, so a test can name the fixture it means
          // instead of rediscovering it from pixel widths.
          label: name?.textContent?.trim() ?? null,
          wrapper: box(wrapper)!,
          pill: pillBox,
          name: box(name),
          close: box(pill.querySelector("button[aria-label^='Close']"))!,
          contentRight:
            pillBox.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
        };
      }),
    };
  });
}

/**
 * Shared by both modes: the × sits ON the pill's content edge, never floating
 * inside it (#1736). Distinct from `assertNothingSpills`, which only catches a
 * button that has escaped its pill — a button parked 38px short of the edge
 * satisfies that one completely.
 */
function assertCloseFlush(measured: Awaited<ReturnType<typeof measureTabStrip>>) {
  for (const tab of measured.tabs) {
    // Sub-pixel only. A regression here is tens of pixels, not fractions.
    expect(
      Math.abs(tab.contentRight - tab.close.right),
      `the close button drifted off the pill's content edge on "${tab.label}"`,
    ).toBeLessThanOrEqual(1);
  }
}

/** Shared by both modes: nothing escapes its pill, and the actions cluster survives. */
function assertNothingSpills(measured: Awaited<ReturnType<typeof measureTabStrip>>) {
  for (const tab of measured.tabs) {
    // 0.5px for subpixel flex rounding.
    if (tab.name) {
      expect(tab.name.left).toBeGreaterThanOrEqual(tab.pill.left - 0.5);
      expect(tab.name.right).toBeLessThanOrEqual(tab.pill.right + 0.5);
    }
    expect(tab.close.left).toBeGreaterThanOrEqual(tab.pill.left - 0.5);
    expect(tab.close.right).toBeLessThanOrEqual(tab.pill.right + 0.5);
  }
  // The center cluster is the only shrinkable item in the title-bar row, so a
  // crowded strip must never push the actions cluster off-screen.
  expect(measured.actions.width).toBeGreaterThan(0);
  expect(measured.actions.left).toBeGreaterThanOrEqual(-0.5);
  expect(measured.actions.right).toBeLessThanOrEqual(measured.viewportWidth + 0.5);
}

test("uniform mode: every tab is the same width, and the strip still scrolls", async ({ page }) => {
  await openFixtureTabs(page, true);
  const measured = await measureTabStrip(page);

  expect(measured.tabs.every((t) => t.uniform)).toBe(true);

  // Guard against `flex-grow` filling the scroller exactly: if it ever does,
  // scrollWidth === clientWidth, updateScrollState never fires, and the mask
  // fade plus horizontal scroll disappear permanently (lesson 85).
  expect(measured.overflowing).toBe(true);
  expect(measured.scrollerClass).toMatch(/has-overflow|overflow-left|overflow-right/);

  const widths = measured.tabs.map((t) => t.wrapper.width);
  // The whole point of the mode: a 2-character name and a 28-character name
  // occupy identical space. Also the regression detector for a name-span-based
  // pin, which left read-only and renaming tabs 80-145px wider than the rest.
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  expect(Math.max(...widths)).toBeCloseTo(FLOOR_PX, 0);

  assertNothingSpills(measured);
});

/**
 * #1736. A uniform-mode pill is padded out to 142px, so a short name leaves
 * slack inside it — and that slack used to park after the last child, leaving
 * ~38px of void between the × and the tab's right edge. `assertNothingSpills`
 * is blind to it: nothing overflowed, it was just wrong.
 *
 * The second assertion is the load-bearing one, and it is here rather than in
 * the adaptive tests on purpose. The rejected fix — growing the name span —
 * produces close-button pixels identical to the shipped one, so `assertCloseFlush`
 * passes under it; what it breaks is the adaptive floor (see `measureTabFloor`,
 * whose `scrollWidth` read is the canonical explanation). The adaptive tests
 * below do go red, but they read as unrelated breakage. This assertion names
 * the cause at the site of the change.
 *
 * Both assertions need real layout, so neither can move to the unit suite:
 * happy-dom has no layout engine, and a vitest check on the style string would
 * pin the fix's spelling rather than its effect.
 */
test("uniform mode: the close button sits flush at the tab's right edge whatever the name's length (#1736)", async ({
  page,
}) => {
  await openFixtureTabs(page, true);
  const measured = await measureTabStrip(page);

  assertCloseFlush(measured);

  // The slack must land BETWEEN the name and the ×, which is the same thing as
  // saying the name span never absorbed it. `ab.md` is the declared dispersion
  // probe: its name box stays shrink-wrapped at its text width while the pill
  // around it is padded to 142px, so a real gap opens before the button.
  const probe = measured.tabs.find((t) => t.label === "ab.md");
  expect(probe, "the ab.md dispersion probe is missing from the strip").toBeDefined();
  expect(
    probe!.close.left - probe!.name!.right,
    "ab.md's name span absorbed the slack — see `measureTabFloor`",
  ).toBeGreaterThan(20);

  assertNothingSpills(measured);
});

test("adaptive mode: the close button is flush there too, with no slack to absorb (#1736)", async ({
  page,
}) => {
  await openFixtureTabs(page, false);
  const measured = await measureTabStrip(page);

  assertCloseFlush(measured);

  // No fixture tab is renaming, so every tab has a name span. Asserted rather
  // than filtered: skipping a nameless tab would silently skip the tab the
  // assertion below exists for.
  expect(
    measured.tabs.every((t) => t.name),
    "a tab was renaming mid-measurement",
  ).toBe(true);

  // The mode's own invariant, stated as geometry: the measured floor IS
  // chrome + the name's natural width, so the × lands right after the name with
  // only the 6px column gap between them (plus `measureTabFloor`'s 1px
  // rounding allowance). Nothing to absorb, nothing to park. If this ever
  // grows, the floor and the rendered pill have desynchronised.
  for (const tab of measured.tabs) {
    expect(tab.close.left - tab.name!.right).toBeLessThanOrEqual(8);
  }
});

test("adaptive mode: tabs size to their own name, and long ones still compress", async ({
  page,
}) => {
  await openFixtureTabs(page, false);
  const measured = await measureTabStrip(page);

  expect(measured.tabs.some((t) => t.uniform)).toBe(false);

  // Still overflows — otherwise the floor assertions below are vacuous.
  expect(measured.overflowing).toBe(true);
  expect(measured.scrollerClass).toMatch(/has-overflow|overflow-left|overflow-right/);

  const widths = measured.tabs.map((t) => t.wrapper.width);
  // THE assertion for this mode. The bug being fixed was every tab landing on
  // the floor regardless of its name, which reads as "all tabs are identical".
  expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(15);

  for (const tab of measured.tabs) {
    // Upper bound is the no-compression regression detector: the
    // shipped-then-reverted shape left a long name pinned at 259px. It is also
    // the adaptive ceiling — a tab is never wider than the uniform width once
    // the strip is crowded.
    expect(tab.wrapper.width).toBeLessThanOrEqual(FLOOR_PX + 0.5);
    // Lower bound: a tab may be narrower than the floor ONLY because its own
    // name needs less. It may never be narrower than its own chrome, which is
    // what would make the close button collide with the name.
    expect(tab.wrapper.width).toBeGreaterThan(60);
  }

  // A short name must not be truncated — that is what distinguishes this mode
  // from a uniformly-floored strip, where `ab.md` is padded out to 142px.
  const shortest = measured.tabs.reduce((a, b) => (a.wrapper.width <= b.wrapper.width ? a : b));
  expect(shortest.wrapper.width).toBeLessThan(FLOOR_PX - 5);

  assertNothingSpills(measured);
});

test("toggling the setting live re-sizes the strip, stranding no per-tab floor", async ({
  page,
}) => {
  // The two tests above each seed the setting before first paint, so neither
  // exercises the transition. That leaves the one path where the CSS clamp is
  // not self-sufficient: adaptive mode writes an INLINE `min-width` per tab,
  // and inline beats `.tab-flip.uniform`'s class-selector `min-width`. If the
  // effect ever stopped clearing those on the way into uniform mode, the CSS
  // would look correct, every unit test would pass, and the strip would simply
  // stay ragged.
  await openFixtureTabs(page, false);
  const before = await measureTabStrip(page);
  const beforeWidths = before.tabs.map((t) => t.wrapper.width);
  expect(Math.max(...beforeWidths) - Math.min(...beforeWidths)).toBeGreaterThan(15);

  await openSettingsViaBrandMenu(page);
  await page.locator("[data-testid='appearance-uniform-tab-width'] input").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='settings-modal']")).toHaveCount(0, { timeout: 2_000 });

  // Poll: the class flip and the effect that clears the inline floors land in
  // separate flushes, so a single measurement can catch the strip mid-way.
  await expect
    .poll(
      async () => {
        const w = (await measureTabStrip(page)).tabs.map((t) => t.wrapper.width);
        return Math.max(...w) - Math.min(...w);
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(1);

  const after = await measureTabStrip(page);
  expect(after.tabs.every((t) => t.uniform)).toBe(true);
  // Not just equal to each other — equal at the FLOOR. A stranded 102px inline
  // min-width would still let the tabs agree with one another at the wrong size.
  expect(Math.max(...after.tabs.map((t) => t.wrapper.width))).toBeCloseTo(FLOOR_PX, 0);
  assertNothingSpills(after);
});

/**
 * Opening-a-tab timing regression (#1257 Fix 1). The three tests above all run
 * under `emulateMedia({ reducedMotion: "reduce" })`, which short-circuits
 * `tabEnter`/`tabExit` to `{ duration: 0 }` — they cannot see this bug even
 * after the fix. This test deliberately leaves motion ON (Playwright's default
 * context `reducedMotion` is "no-preference" — nothing in this file forces
 * "reduce" at the top level, only `openFixtureTabs` does it per-call).
 *
 * The bug: `tabEnter` used to read `node.offsetWidth` at transition SETUP time,
 * which runs during Svelte's render/DOM-patch pass — strictly BEFORE
 * DocumentTabs' adaptive-floor `$effect` flushes. For a newly-opened adaptive
 * tab that reads only the un-floored base CSS (`.tab-flip{min-width:142px}`),
 * so a short-named tab would visibly unroll 0→142px and then SNAP to its real
 * (smaller) floor the instant the effect ran moments later.
 *
 * Rather than sampling mid-animation (timing-sensitive, flaky), this inspects
 * the actual `Animation` Svelte installs via `element.animate()`: the WIDTH
 * baked into its keyframes at setup time IS the bug signal — a regression
 * would show every keyframe's width running up to 142px regardless of the
 * tab's own name, even though nothing has visually settled yet.
 */
test("adaptive mode: a newly-opened tab's enter transition targets its OWN adaptive floor, never the uniform 142px floor (#1257)", async ({
  page,
}) => {
  // Seed several long-named tabs (crowds the strip, matching the other tests'
  // fixture pattern) and load with motion enabled and adaptive mode on.
  const longNames = Array.from({ length: 6 }, (_, i) => `tandem-ink-email-runbook-${i + 1}.md`);
  for (const name of longNames) {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, `# ${name}\n\nSizing fixture.\n`);
    await mcp.callTool("tandem_open", { filePath });
  }

  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({ schemaVersion: 18, uniformTabWidth: value }),
      );
    },
    ["tandem:settings", false],
  );

  await page.goto("/");
  await page.waitForSelector("[data-testid='tab-scroll-container']");
  // Svelte skips intros on the initial render, so these existing tabs mount
  // without an `in:` transition — settle before opening the probe tab.
  await expect
    .poll(() => page.locator(".tab-flip").count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(longNames.length);

  // Open ONE more tab, with a deliberately short name, AFTER the app has
  // mounted — this is the only way to get a genuine `in:tabEnter` intro.
  const shortName = "ab.md";
  const shortPath = path.join(tmpDir, shortName);
  fs.writeFileSync(shortPath, `# ${shortName}\n\nSizing fixture.\n`);
  await mcp.callTool("tandem_open", { filePath: shortPath });

  // Poll (from inside the page, to avoid a Playwright-side fixed sleep) for
  // the REAL eased keyframe set. Svelte's transition setup first installs a
  // 0-duration "freeze at t=0" dummy animation (two identical width:0px
  // keyframes) and swaps it for the full multi-sample animation on the dummy's
  // `onfinish` — so wait for more than 2 keyframes before reading the target.
  const keyframeWidths = await page.evaluate(async (name) => {
    function findWrapper(): Element | null {
      const nameEl = [...document.querySelectorAll("[data-testid^='tab-name-']")].find(
        (el) => el.textContent === name,
      );
      return nameEl?.closest(".tab-flip") ?? null;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const wrapper = findWrapper() as (Element & { getAnimations?: () => Animation[] }) | null;
      const anim = wrapper?.getAnimations?.()[0];
      const kfs = anim?.effect instanceof KeyframeEffect ? anim.effect.getKeyframes() : [];
      if (kfs.length > 2) return kfs.map((k) => k.width as string);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return null;
  }, shortName);

  expect(keyframeWidths).not.toBeNull();
  const targetWidth = parseFloat(String(keyframeWidths?.at(-1)));
  expect(Number.isFinite(targetWidth)).toBe(true);
  // THE assertion: the animation's own target, baked in at setup time, must be
  // this short tab's adaptive floor — well under the 142px uniform floor —
  // not 142px itself. (A regression here shows up as ~142 regardless of name.)
  expect(targetWidth).toBeLessThan(120);
  expect(targetWidth).toBeGreaterThan(40);

  // And once the transition (TAB_ENTER_MS=220ms) plus the adaptive-floor
  // effect have both settled, the RESTING width must equal that same target —
  // no post-transition snap to a different number.
  await page.waitForTimeout(400);
  const restWidth = await page.evaluate((name) => {
    const nameEl = [...document.querySelectorAll("[data-testid^='tab-name-']")].find(
      (el) => el.textContent === name,
    );
    return nameEl?.closest(".tab-flip")?.getBoundingClientRect().width ?? null;
  }, shortName);
  expect(restWidth).not.toBeNull();
  expect(Math.abs((restWidth as number) - targetWidth)).toBeLessThan(2);
});
