/**
 * Deterministic screenshot capture for docs/screenshots/*.png.
 *
 * THIS IS THE ONLY SCREENSHOT PIPELINE. `scripts/take-screenshots.mjs` was
 * deleted (docs/post-v0221-overhaul): two pipelines writing the same filenames
 * meant whichever ran last decided what the README showed, and the two used
 * different framing and different seed data for the three shots they shared.
 * Its unique recipes (02 chat, 06 status pill, 07 toast) and its better framing
 * for 03/04 were ported here first.
 *
 * Lives under scripts/screenshots/ with its own playwright.config.ts so the
 * root test runner (`npm run test:e2e`) can't pick it up. To regenerate the
 * screenshot set (e.g. after a UI refresh):
 *
 *   npm run capture:screenshots
 *
 * Which slot must depict what — and which doc embeds it — is
 * `docs/screenshots/README.md`. That table is the spec; this file implements it.
 *
 * ## Two rules this file exists to enforce
 *
 * 1. **Every `page.screenshot()` is preceded by an `expect()` on the thing the
 *    shot is meant to show.** A capture step with no assertion writes *something*
 *    regardless of whether the UI rendered — the image looks plausible and is
 *    wrong. The predecessor script had four steps like that.
 * 2. **A skip is a failure.** No `try {} catch { console.warn("SKIPPED") }`.
 *    The predecessor skipped 07 and 08 silently; 08's on-disk file was four
 *    months older than the rest of the set and nothing said so. If a shot cannot
 *    be taken, the run must go red rather than leave a stale file in place.
 *
 * Text anchors, not offsets: annotation ranges are resolved by `indexOf` against
 * `tandem_getTextContent` (whose offsets are the annotation coordinate system),
 * and a missing snippet THROWS. Blind offsets into `sample/welcome.md` stay
 * *valid* when the prose changes — they just land on different text, so the
 * screenshot is quietly wrong.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  McpTestClient,
  openSettingsViaBrandMenu,
  setRailVisible,
  switchToAnnotationsTab,
} from "../../tests/e2e/helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const screenshotsDir = path.join(repoRoot, "docs", "screenshots");
const welcomePath = path.join(repoRoot, "sample", "welcome.md");

/**
 * `MARGIN_TRACK_GEOMETRY.full.column` from
 * `src/client/layout/editor-stage.svelte.ts`, copied rather than imported: that
 * module uses runes at module scope-adjacent positions and Playwright's
 * transform has no Svelte compiler. `narrow` is 160 and `stub` is 28, so any
 * threshold in (160, 240] discriminates the degraded ladder states. Update
 * alongside the table if full-mode geometry ever changes.
 */
const MARGIN_FULL_COLUMN_PX = 240;

// Skip the entire file unless explicitly requested.
test.skip(!process.env.SCREENSHOTS, "manual screenshot capture — run with SCREENSHOTS=1 to enable");

let mcp: McpTestClient;
let tmpDir: string;

/** Loose view of the MCP envelope — enough to detect RANGE_MOVED and failures. */
type Envelope = {
  error?: boolean;
  code?: string;
  message?: string;
  details?: { resolvedFrom?: number; resolvedTo?: number };
  data?: Record<string, unknown>;
};

test.beforeAll(() => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
});

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // Start with a clean slate — close anything previous tests left open.
  await cleanupAllOpenDocuments(mcp);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-shot-"));
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── MCP seeding helpers ──────────────────────────────────────────────────────

/**
 * Open `sample/welcome.md` and dismiss the tutorial annotations it injects.
 *
 * `openFileByPath` seeds `tutorial-*` annotations idempotently whenever the
 * sample doc is opened (see CLAUDE.md). They are instructional, not
 * representative, and they crowd the side panel out of every shot — so they are
 * dismissed rather than captured.
 */
async function openWelcome(): Promise<string> {
  const res = (await mcp.callTool("tandem_open", { filePath: welcomePath })) as Envelope;
  const documentId = res.data?.documentId as string | undefined;
  if (!documentId) throw new Error(`tandem_open returned no documentId: ${JSON.stringify(res)}`);

  const anns = (await mcp.callTool("tandem_getAnnotations", { documentId })) as Envelope;
  const list = (anns.data?.annotations ?? []) as Array<{ id?: string; status?: string }>;
  for (const ann of list) {
    if (ann.status === "pending" && ann.id?.startsWith("tutorial-")) {
      await mcp.callTool("tandem_resolveAnnotation", {
        annotationId: ann.id,
        action: "dismiss",
        documentId,
      });
    }
  }
  return documentId;
}

/** Flat text in the annotation coordinate system (heading prefixes included). */
async function documentText(documentId: string): Promise<string> {
  const res = (await mcp.callTool("tandem_getTextContent", { documentId })) as Envelope;
  const text = res.data?.text as string | undefined;
  if (!text) throw new Error("tandem_getTextContent returned no text");
  return text;
}

/**
 * Resolve a prose snippet to a flat offset range.
 *
 * THROWS when the snippet is gone. The predecessor returned `null` and its
 * callers dropped the annotation — the shot simply came out missing a card,
 * with a `console.warn` nobody read. If you edit `sample/welcome.md`, this
 * function is what tells you which shot you just broke.
 */
function findRange(docText: string, snippet: string): { from: number; to: number } {
  const idx = docText.indexOf(snippet);
  if (idx === -1) {
    throw new Error(
      `Screenshot anchor not found in sample/welcome.md: "${snippet}". ` +
        "Update the anchor in capture.spec.ts to match the current prose.",
    );
  }
  return { from: idx, to: idx + snippet.length };
}

/**
 * Create an annotation, retrying once on RANGE_MOVED with the server-resolved
 * offsets. Any other failure throws — an annotation this file asks for is one
 * the screenshot needs.
 */
async function annotate(args: Record<string, unknown>): Promise<void> {
  let res = (await mcp.callTool("tandem_comment", args)) as Envelope;
  if (res.code === "RANGE_MOVED" && res.details?.resolvedFrom !== undefined) {
    res = (await mcp.callTool("tandem_comment", {
      ...args,
      from: res.details.resolvedFrom,
      to: res.details.resolvedTo,
    })) as Envelope;
  }
  if (res.error) {
    throw new Error(`tandem_comment failed: ${res.code ?? ""} ${res.message ?? ""}`.trim());
  }
}

/**
 * Open welcome.md and seed four text-anchored annotations, one of them a
 * suggestion (03's whole point is the strike/green replacement diff).
 */
async function openWithAnnotations(): Promise<string> {
  const documentId = await openWelcome();
  const text = await documentText(documentId);

  const openerText = "Both you and your AI can see and edit this document at the same time";
  await annotate({
    ...findRange(text, openerText),
    text: "Great opening line — sets collaborative expectations immediately.",
    textSnapshot: openerText,
  });

  const stepText = "Respond to a suggestion";
  await annotate({
    ...findRange(text, stepText),
    text: "Consider linking to a specific annotation so new users don't have to search for one.",
    textSnapshot: stepText,
  });

  // The suggestion. 03-side-panel and the README hero both depend on this one
  // rendering as a replacement card (red strikethrough + green proposed text).
  const sentenceText = "The project launched in early 2025 with three core goals";
  await annotate({
    ...findRange(text, sentenceText),
    text: "Active voice and a stronger verb make this punchier.",
    suggestedText: "In early 2025, the project set three ambitious goals",
    textSnapshot: sentenceText,
  });

  const slipText = "the dashboard slipped to Q4 after an unexpected API redesign in May";
  await annotate({
    ...findRange(text, slipText),
    text: "A new date without a recovery plan still reads as a slip. Say what changed before sharing externally.",
    textSnapshot: slipText,
  });

  return documentId;
}

/** Write three extra documents to the temp dir and open them, for the tab bar. */
async function openExtraDocuments(): Promise<string[]> {
  const files = [
    {
      name: "quarterly-budget-analysis-2025.md",
      content:
        "# Quarterly Budget Analysis 2025\n\nThis document summarizes the budget performance for Q1-Q3.\n\n## Revenue\n\nTotal revenue reached $4.2M, exceeding the forecast by 12%.\n\n## Expenses\n\nOperating costs were within budget at $2.8M.\n",
    },
    {
      name: "product-roadmap.md",
      content:
        "# Product Roadmap\n\n## Q1 Milestones\n\n- Launch collaborative editing\n- Ship annotation system\n- MCP integration\n\n## Q2 Goals\n\n- Word document support\n- Channel push notifications\n",
    },
    {
      name: "meeting-notes-march.md",
      content:
        "# Meeting Notes — March 2025\n\n## Attendees\n\nBryan, Sarah, Mike, Claude\n\n## Action Items\n\n1. Finalize the API spec by Friday\n2. Review the NPS survey results\n3. Schedule the Q2 planning session\n",
    },
  ];
  const ids: string[] = [];
  for (const f of files) {
    const fp = path.join(tmpDir, f.name);
    fs.writeFileSync(fp, f.content);
    const res = (await mcp.callTool("tandem_open", {
      filePath: fp.replace(/\\/g, "/"),
    })) as Envelope;
    const id = res.data?.documentId as string | undefined;
    if (!id) throw new Error(`tandem_open returned no documentId for ${f.name}`);
    ids.push(id);
  }
  return ids;
}

// ── Page helpers ─────────────────────────────────────────────────────────────

/**
 * Dismiss the store-read-only banner if it is up. This is cleanup, not capture:
 * the banner appears whenever another Tandem instance holds the annotations
 * lock, it only affects PERSISTENCE (annotations still render), and without
 * this every panel shot ships with an amber warning across the top. Its
 * absence is the normal case, so this one conditional is deliberate.
 */
async function dismissReadOnlyBanner(page: Page): Promise<void> {
  const dismiss = page.getByTestId("store-readonly-dismiss");
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await page.waitForTimeout(300);
  }
}

/** Load the app, wait for the editor + first annotation card, settle animations. */
async function gotoAnnotatedEditor(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);
  await switchToAnnotationsTab(page);
  await expect(page.locator("[data-testid^='annotation-card-']").first()).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
}

/** Select the opening run of the first paragraph so the selection is in frame. */
async function selectFirstParagraph(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror");
    const firstPara = pm?.querySelector("p");
    const textNode = firstPara?.firstChild;
    if (!pm || !textNode) throw new Error("No first paragraph text node to select");
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(60, textNode.textContent?.length ?? 0));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    pm.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(300);
}

/** Open Settings and land on the AI Assistant tab (id `claude-code`). */
async function openSettingsClaudeCodeTab(page: Page): Promise<Locator> {
  await openSettingsViaBrandMenu(page);
  const modal = page.locator("[data-testid='settings-modal']");
  await expect(modal).toBeVisible({ timeout: 3_000 });
  // Below 860px the nav sidebar collapses into an inert drawer; open it first.
  const hamburger = page.locator("[data-testid='settings-modal-narrow-hamburger']");
  if (await hamburger.isVisible().catch(() => false)) await hamburger.click();
  await page.locator("[data-testid='settings-modal-tab-claude-code']").click();
  return modal;
}

// ── Captures ─────────────────────────────────────────────────────────────────

test("01-editor-overview", async ({ page }) => {
  // The hero. Wider than the rest so the document, the annotation rail and the
  // tab bar all read at README's 820px display width.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openWithAnnotations();
  await gotoAnnotatedEditor(page);

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(4, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("mode-toggle")).toBeVisible();

  await page.screenshot({
    path: path.join(screenshotsDir, "01-editor-overview.png"),
    fullPage: false,
  });
});

test("02-chat-sidebar", async ({ page }) => {
  // Ported from take-screenshots.mjs. The privacy hazard that recipe carried —
  // it captured the operator's REAL chat history into a public README image —
  // cannot occur here: this pipeline runs against the isolated, per-run
  // TANDEM_APP_DATA_DIR, so there is no prior conversation to leak.
  await openWithAnnotations();
  await gotoAnnotatedEditor(page);

  await page.getByTestId("chat-tab").click();
  // The Annotations tab must stay visible beside it: the post-Wave-I right rail
  // is a fixed two-tab panel and the shot is meant to show that.
  await expect(page.getByTestId("annotations-tab")).toBeVisible();

  // Targeted by testid. This previously used `textarea.chat-composer-input`, a
  // class the redesign renamed to `chat-textarea`; the locator stopped matching,
  // a `.catch(() => false)` swallowed it, and the block was skipped SILENTLY on
  // every run — the user turn visible in past screenshots was leftover chat
  // history, not anything the script produced. Hence the hard assertion.
  const chatInput = page.getByTestId("chat-composer-input");
  await expect(chatInput).toBeVisible({ timeout: 5_000 });
  await chatInput.click();
  await chatInput.fill(
    "Can you look at the sample content section? The timeline details feel vague.",
  );
  await page.getByTestId("chat-send-btn").click();

  await mcp.callTool("tandem_reply", {
    text: "The sample content section uses passive constructions and buries the timeline slip. I've added a suggestion to tighten the opening sentence — active voice makes the goals land harder. For the slip mention, I flagged it: it needs a concrete mitigation plan before this goes external.",
  });

  const chatPanel = page.getByTestId("chat-panel");
  // Both turns must be on screen — a reply that never arrived is exactly the
  // failure this shot cannot show and an unasserted capture would hide.
  await expect(chatPanel).toContainText("The timeline details feel vague.", { timeout: 10_000 });
  await expect(chatPanel).toContainText("active voice makes the goals land harder", {
    timeout: 10_000,
  });

  // A pending follow-up so the composer reads as live rather than empty.
  await chatInput.click();
  await chatInput.fill("Makes sense. Accept the suggestion and let's move on.");
  await page.waitForTimeout(300);

  await chatPanel.screenshot({ path: path.join(screenshotsDir, "02-chat-sidebar.png") });
});

test("03-side-panel", async ({ page }) => {
  await openWithAnnotations();
  await gotoAnnotatedEditor(page);

  // Element screenshot of the annotation list, ported from take-screenshots.mjs.
  // The old approach here was a 420px slice anchored to the right edge of the
  // viewport; the .mjs had already learned the same lesson with a hardcoded
  // `{x:940,y:40,w:460,h:750}` clip that drifted after the floating-chrome
  // redesign and framed the toolbar instead of the cards. An element shot
  // cannot drift, and the list is exactly what this shot is meant to show.
  const list = page.getByTestId("annotation-list-scroll-container");
  await expect(list).toBeVisible({ timeout: 10_000 });
  // The suggestion card is the reason this shot exists — README's alt text
  // promises the strikethrough/green replacement diff and Accept/Reject.
  await expect(list).toContainText("In early 2025, the project set three ambitious goals", {
    timeout: 10_000,
  });

  await list.screenshot({ path: path.join(screenshotsDir, "03-side-panel.png") });
});

test("04-toolbar-actions", async ({ page }) => {
  const welcomeId = await openWithAnnotations();
  const [budgetId] = await openExtraDocuments();

  // One read-only tab (RO badge) and one dirty tab (unsaved dot). `tandem_open`
  // has no readOnly parameter — only `POST /api/open` does — so the read-only
  // tab is opened over the API from the page's own (loopback) context.
  const roPath = path.join(tmpDir, "reference-spec.md");
  fs.writeFileSync(roPath, "# Reference Spec\n\nRead-only reference material.\n");
  const roRes = await page.request.post(`http://127.0.0.1:${DEFAULT_MCP_PORT}/api/open`, {
    data: { filePath: roPath.replace(/\\/g, "/"), readOnly: true },
  });
  if (!roRes.ok())
    throw new Error(`read-only open failed: ${roRes.status()} ${await roRes.text()}`);
  await mcp.callTool("tandem_appendContent", {
    documentId: budgetId,
    content: "\n## Outlook\n\nQ4 forecast pending finance review.\n",
  });
  await mcp.callTool("tandem_switchDocument", { documentId: welcomeId });

  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);
  await selectFirstParagraph(page);

  // Everything the two captions promise, asserted rather than hoped for.
  await expect(page.locator("[data-testid^='tab-']")).not.toHaveCount(0);
  await expect(page.locator(".tab-ro-badge").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid^='unsaved-indicator-']").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("mode-toggle")).toBeVisible();
  const formattingBar = page.getByTestId("formatting-bar");
  await expect(formattingBar).toBeVisible({ timeout: 10_000 });

  // Height derived from the formatting bar rather than a fixed 180px, which had
  // become a thin strip cutting the selected line mid-glyph. Take the bar's
  // bottom edge plus a few lines of editor so the selection is fully in frame.
  const barBox = await formattingBar.boundingBox();
  if (!barBox) throw new Error("formatting-bar has no bounding box");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  await page.screenshot({
    path: path.join(screenshotsDir, "04-toolbar-actions.png"),
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.min(viewport.height, Math.round(barBox.y + barBox.height + 190)),
    },
  });
});

/*
 * 05-review-mode: DELETED, step and file both.
 *
 * Review Mode was removed from the product (`useAnnotationReview.svelte.ts`
 * records the removal; no Ctrl+Shift+R handler exists anywhere in src/client).
 * The predecessor pressed Ctrl+Shift+R unconditionally and wrote a plain-editor
 * screenshot under a review-mode name — its Jul 22 mtime proves the step re-ran.
 * Deleting the image alone would have been undone by the next capture run, so
 * the step goes with it. Do not re-add.
 */

test("06-claude-presence", async ({ page }) => {
  // Ported from take-screenshots.mjs, with the viewport-coupled clip replaced.
  const documentId = await openWithAnnotations();
  await gotoAnnotatedEditor(page);

  await mcp.callTool("tandem_status", {
    text: "Analyzing paragraph structure and readability...",
    focusParagraph: 3,
    documentId,
  });

  // The pill is faint until hover/focus-within (pure-CSS opacity transition),
  // so it must be revealed before it is worth photographing.
  const pill = page.locator("[data-status-focus-root]");
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await pill.hover();
  await expect(page.getByTestId("status-ai-indicator").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("status-word-count")).toBeVisible();
  await page.waitForTimeout(400);

  // Element screenshot. The old `{x:0, y:860, w:1400, h:40}` clip was coupled to
  // one viewport height and to the pre-floating-chrome in-flow status bar; the
  // pill is now `position: fixed` bottom-left and a fixed clip misses it.
  await pill.screenshot({ path: path.join(screenshotsDir, "06-claude-presence.png") });
});

test("07-toast-notification", async ({ page }) => {
  // Ported from take-screenshots.mjs — with all three swallows removed.
  //
  // The predecessor triggered the toast by calling `tandem_comment` with a
  // deliberately unmatchable `textSnapshot` inside a bare `try {} catch {}`,
  // then wrapped the capture in a `try` with TWO `console.warn("SKIPPED")` arms.
  // Nothing distinguished "wrote a fresh 07" from "left the old one in place",
  // and if the trigger ever started *succeeding* the toast would simply never
  // appear — silently. The trigger here is the deterministic success toast the
  // e2e suite already pins (settings-modal.spec.ts E5), and every arm asserts.
  await page.route("**/api/integrations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ integrations: [{ kind: "claude-code" }] }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/launcher/working-directory", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, workingDirectory: null }),
      });
    } else {
      await route.continue();
    }
  });

  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);

  await openSettingsClaudeCodeTab(page);
  await expect(page.getByTestId("settings-modal-working-directory")).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId("settings-modal-working-directory-save").click();

  // `info` toasts auto-dismiss after TOAST_DISMISS_MS.info (4s), so this shot is
  // time-bounded: assert, then capture immediately. If the toast is gone the
  // assertions fail loudly rather than leaving the previous file in place.
  const toast = page.getByTestId("toast-container");
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText("Working directory saved.");
  await expect(page.locator("[data-testid^='toast-dismiss-']").first()).toBeVisible();

  await toast.screenshot({ path: path.join(screenshotsDir, "07-toast-notification.png") });
});

test("08-onboarding-tutorial", async ({ page }) => {
  // Ported from take-screenshots.mjs. There the capture sat inside a `try` whose
  // `catch` wrote `console.warn("   SKIPPED")` — which is why the committed file
  // carried an Apr 12 mtime while 01-07 were Jul 22: it was skipped in the last
  // run and the stale image survived, invisibly. Here the card must be visible
  // or the run fails.
  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  // The component reads localStorage once at construction, so the flag must be
  // cleared and the page reloaded — setting it post-navigation is too late.
  await page.evaluate(() => localStorage.removeItem("tandem:tutorialCompleted"));
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });

  const card = page.locator("[data-testid='onboarding-tutorial']");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  await card.screenshot({ path: path.join(screenshotsDir, "08-onboarding-tutorial.png") });
});

test("09-settings-modal", async ({ page }) => {
  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);
  const modal = await openSettingsClaudeCodeTab(page);
  await expect(modal).toBeVisible({ timeout: 3_000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshotsDir, "09-settings-modal.png"),
    fullPage: false,
  });
});

test("10-solo-tandem-toggle", async ({ page }) => {
  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);

  const toggle = page.getByTestId("mode-toggle");
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  // Both options must be legible — a close-up of one half is not the control.
  await expect(page.getByTestId("mode-solo-btn")).toBeVisible();
  await toggle.hover();
  await page.waitForTimeout(300);

  await toggle.screenshot({ path: path.join(screenshotsDir, "10-solo-tandem-toggle.png") });
});

test("11-margin-annotations", async ({ page }) => {
  // Margin view is opt-in AND width-gated. Both must be satisfied, and the
  // width must be ASSERTED, not assumed: below the `full` threshold the ladder
  // silently steps down to `narrow` (no action row) or `stub` (a pip), and the
  // shot degrades into something that does not show what the caption claims.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openWithAnnotations();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);

  // Open rails feed the auto-hide threshold; close both so `full` is reachable.
  await setRailVisible(page, "left", false);
  await setRailVisible(page, "right", false);

  await openSettingsClaudeCodeTab(page);
  const marginToggle = page.locator("[data-testid='settings-modal-margin-view-toggle'] input");
  if (!(await marginToggle.isChecked())) await marginToggle.click();
  await expect(marginToggle).toBeChecked();
  await page.keyboard.press("Escape");

  const column = page.locator("[data-testid='margin-column-right']");
  await expect(column).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid^='margin-bubble-']").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator("[data-testid='margin-anchor-dot']").first()).toBeVisible();
  // `full` is 240px; `narrow` is 160 and `stub` is 28. This is the assertion
  // that stops a degraded ladder state shipping as a full-margin screenshot.
  const columnBox = await column.boundingBox();
  if (!columnBox) throw new Error("margin-column-right has no bounding box");
  expect(columnBox.width).toBeGreaterThanOrEqual(MARGIN_FULL_COLUMN_PX);
  await page.waitForTimeout(500);

  await page.screenshot({
    path: path.join(screenshotsDir, "11-margin-annotations.png"),
    fullPage: false,
  });
});

test("12-outline-rail", async ({ page }) => {
  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);
  await setRailVisible(page, "left", true);

  const rail = page.getByTestId("left-outline-rail");
  await expect(rail).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("outline-panel")).toBeVisible();
  await expect(page.getByTestId("outline-search-input")).toBeVisible();
  // welcome.md carries six headings across two levels; a flat document would
  // produce a technically-correct screenshot of an empty tree.
  await expect(page.locator("[data-testid^='outline-heading-']")).not.toHaveCount(0);
  await page.waitForTimeout(400);

  await rail.screenshot({ path: path.join(screenshotsDir, "12-outline-rail.png") });
});

test("13-setup-wizard", async ({ page }) => {
  // The wizard CANNOT be reached through first-run here: the root
  // playwright.config.ts sets TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV=1 before
  // `defineConfig`, and the screenshots config spreads that base. Waiting for a
  // first-run wizard would look like an unexplained timeout. The manual reopen
  // entry point is deterministic and leaves first-run state alone.
  //
  // PRIVACY: this shot can render host and path detail
  // (`integration-wizard-reachability-*`). It needs a human check before it is
  // committed even though the capture is automated — see docs/screenshots/README.md.
  await openWelcome();
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);

  await openSettingsClaudeCodeTab(page);
  await page.getByTestId("settings-modal-open-integration-wizard").click();

  const wizard = page.getByTestId("integration-wizard");
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid^='integration-wizard-card-']").first()).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(400);

  await page.screenshot({
    path: path.join(screenshotsDir, "13-setup-wizard.png"),
    fullPage: false,
  });
});
