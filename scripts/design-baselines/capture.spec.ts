/**
 * Visual baseline HTML capture — Phase 0i of the design-system-impl umbrella.
 *
 * Generates self-contained HTML files (markup + inlined CSS) for the eight
 * cross-cutting / shared-recipe surfaces, light + dark = 16 files total.
 * Writes to `docs/design-system-impl/preview/baselines/` so OpenDesign and
 * any browser can render them as-is.
 *
 * NOT a test — no assertions, no regression gate. The role is **visual
 * reference library**: a place to see what each surface currently looks
 * like in both themes. Cross-surface drift surfaces at PR review time via
 * the git diff of the committed HTML files (markup + class changes are
 * human-readable), not via automated CI failure.
 *
 * Run:
 *   npm run capture:design-baselines
 *
 * Sub-PR ritual: when a sub-PR re-skins a surface covered here, re-run
 * this command, commit the regenerated HTML for that surface (and only
 * that surface), and reviewers can see the markup change in the diff +
 * the visual change in OpenDesign.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  cleanupAllOpenDocuments,
  McpTestClient,
  switchToAnnotationsTab,
} from "../../tests/e2e/helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const welcomePath = path.join(repoRoot, "sample", "welcome.md");
const OUT_DIR = path.join(repoRoot, "docs", "design-system-impl", "preview", "baselines");

// Skip unless the capture command set the gate; mirrors scripts/screenshots pattern.
test.skip(
  !process.env.CAPTURE_DESIGN_BASELINES,
  "Design-baseline capture is on-demand — run `npm run capture:design-baselines`.",
);

test.use({ viewport: { width: 1440, height: 900 } });

let mcp: McpTestClient;

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  await cleanupAllOpenDocuments(mcp);
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
});

async function setThemeBeforeMount(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    const apply = () => document.documentElement.setAttribute("data-theme", t);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    } else {
      apply();
    }
  }, theme);
}

async function seedAnnotations() {
  await mcp.callTool("tandem_open", { filePath: welcomePath });
  await mcp.callTool("tandem_comment", { from: 10, to: 24, text: "Nice opener" });
  await mcp.callTool("tandem_comment", {
    from: 200,
    to: 260,
    text: "Could tighten this — consider dropping the parenthetical.",
  });
  await mcp.callTool("tandem_comment", {
    from: 400,
    to: 470,
    text: "More concise summary",
    suggestedText: "The team hit the first two goals early but missed the dashboard deadline.",
  });
}

async function waitForEditor(page: Page) {
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

/**
 * Capture the full page's HTML with computed CSS inlined into a <style>
 * block. Result is self-contained — opens in any browser or OpenDesign
 * without needing the dev server.
 *
 * Banner at the top names which surface this baseline focuses on so a
 * reviewer opening the file in OD knows what to look at (the full page
 * is captured for context).
 */
async function captureBaseline(
  page: Page,
  surface: string,
  theme: "light" | "dark",
  focus: Locator,
) {
  const focusTag = await focus.evaluate((el) => {
    const id = el.id ? `#${el.id}` : "";
    const testid = el.getAttribute("data-testid");
    const cls =
      el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/)[0]}` : "";
    return `<${el.tagName.toLowerCase()}${id}${testid ? `[data-testid="${testid}"]` : cls}>`;
  });

  const html = await page.evaluate(
    ({ surface, theme, focusTag }) => {
      // Inline every accessible stylesheet. Cross-origin sheets silently
      // skip via try/catch — those tend to be CDN fonts we don't render
      // against in production anyway.
      const cssText = Array.from(document.styleSheets)
        .flatMap((sheet) => {
          try {
            return Array.from(sheet.cssRules).map((r) => r.cssText);
          } catch {
            return [];
          }
        })
        .join("\n");

      const bodyClone = document.body.cloneNode(true) as HTMLElement;

      // Strip runtime-generated framework IDs that would otherwise create
      // spurious diffs between captures of the same scene.
      bodyClone.querySelectorAll("[id^='radix-'], [id^='headlessui-']").forEach((el) => {
        el.removeAttribute("id");
      });

      // Strip every <script>. Captured baselines are inert visual references;
      // any script in the clone (e.g. index.html's theme pre-seed) would
      // re-derive theme from `prefers-color-scheme` and override the
      // <html data-theme="..."> set above, making a "-light" baseline render
      // as dark on a viewer with dark OS preference.
      bodyClone.querySelectorAll("script").forEach((el) => {
        el.remove();
      });

      const banner = `
        <div style="position:sticky;top:0;z-index:99999;background:#111;color:#eaeaea;padding:8px 16px;font:13px/1.4 -apple-system,Segoe UI,system-ui,sans-serif;border-bottom:2px solid #ff5b3a;">
          <strong style="color:#ff5b3a;">Design baseline:</strong>
          ${surface} · ${theme} theme · focus: <code style="background:#222;padding:2px 6px;border-radius:3px;">${focusTag}</code>
          <span style="float:right;opacity:0.6;">tandem · ${new Date().toISOString().slice(0, 10)}</span>
        </div>`;

      return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>Design baseline: ${surface} (${theme})</title>
<style>
${cssText}
</style>
</head>
<body>
${banner}
${bodyClone.innerHTML}
</body>
</html>`;
    },
    { surface, theme, focusTag },
  );

  const outPath = path.join(OUT_DIR, `${surface}-${theme}.html`);
  fs.writeFileSync(outPath, html, "utf-8");
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await setThemeBeforeMount(page, theme);
    });

    test(`title-bar — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      const titleBar = page.locator("[data-testid='title-bar']");
      await expect(titleBar).toBeVisible();
      await captureBaseline(page, "title-bar", theme, titleBar);
    });

    test(`editor-body — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      const editor = page.locator(".ProseMirror").first();
      await captureBaseline(page, "editor-body", theme, editor);
    });

    test(`outline-panel — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      // Left panel may default to collapsed; click the peek strip to expand
      // it so the outline panel renders into the DOM.
      const peekLeft = page.locator("[data-testid='peek-strip-left']");
      if (await peekLeft.isVisible().catch(() => false)) {
        await peekLeft.click();
      }
      const outline = page.locator("[data-testid='outline-panel']");
      await expect(outline).toBeVisible({ timeout: 5_000 });
      await captureBaseline(page, "outline-panel", theme, outline);
    });

    test(`side-panel-annotations — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      await switchToAnnotationsTab(page);
      const rail = page.locator("[data-testid='annotation-list-scroll-container']").first();
      await expect(rail).toBeVisible({ timeout: 5_000 });
      await captureBaseline(page, "side-panel-annotations", theme, rail);
    });

    test(`annotation-card-comment — ${theme}`, async ({ page }) => {
      await seedAnnotations();
      await page.goto("/");
      await waitForEditor(page);
      await switchToAnnotationsTab(page);
      const card = page.locator("[data-testid^='annotation-card-']").first();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await captureBaseline(page, "annotation-card-comment", theme, card);
    });

    test(`formatting-bar — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      await page.evaluate(() => {
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return;
        const firstPara = pm.querySelector("p");
        if (!firstPara) return;
        // Authorship decorations wrap text in spans, so firstPara.firstChild
        // may be an element. Walk for the first actual Text node.
        const walker = document.createTreeWalker(firstPara, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode() as Text | null;
        if (!textNode) return;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(40, textNode.data.length));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        (pm as HTMLElement).dispatchEvent(new Event("focus"));
      });
      await page.waitForTimeout(400);
      const pill = page.locator("[data-testid='formatting-bar']");
      await expect(pill).toBeVisible({ timeout: 5_000 });
      await captureBaseline(page, "formatting-bar", theme, pill);
    });

    test(`command-palette — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      await page.keyboard.press("Control+Shift+P");
      const palette = page.locator("[data-testid='command-palette']");
      await expect(palette).toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(200);
      await captureBaseline(page, "command-palette", theme, palette);
    });

    test(`settings-modal — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      await page.keyboard.press("Control+Shift+Comma");
      const content = page.locator("[data-testid='settings-modal-content']");
      await expect(content).toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(300);
      await captureBaseline(page, "settings-modal", theme, content);
    });

    test(`toast-container — ${theme}`, async ({ page }) => {
      await mcp.callTool("tandem_open", { filePath: welcomePath });
      await page.goto("/");
      await waitForEditor(page);
      await mcp.callTool("tandem_save", { documentId: undefined });
      const toaster = page.locator("[data-testid='toast-container']");
      try {
        await expect(toaster).toBeVisible({ timeout: 2_000 });
        await page.waitForTimeout(150);
        await captureBaseline(page, "toast-container", theme, toaster);
      } catch {
        test.skip(true, "Toast did not render — surface covered by manual walkthrough.");
      }
    });
  });
}
