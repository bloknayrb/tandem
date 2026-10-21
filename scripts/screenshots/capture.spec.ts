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
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  McpTestClient,
  openAnnotatePopup,
  openSettingsViaBrandMenu,
  selectTextStable,
  setRailVisible,
  submitAnnotation,
  switchToAnnotationsTab,
} from "../../tests/e2e/helpers";
import { E2E_MCP_PORT } from "../test-ports";
import {
  type AccountRedactionPlan,
  findAccountPathLeaks,
  planAccountRedaction,
} from "./redact-account";

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

/**
 * The four ids `injectTutorialAnnotations` seeds into `sample/welcome.md`
 * (`src/server/mcp/tutorial-annotations.ts`), listed rather than imported: that
 * module pulls in `yjs` and the whole server position stack, which is a lot of
 * graph to drag into a Playwright transform for four string literals.
 *
 * They must be listed, not discovered. `tandem_getAnnotations` cannot see
 * `tutorial-note-1` — ADR-027 filters notes out of every Claude-facing read —
 * so a list-then-remove sweep leaves the note behind, which is exactly how a
 * private "Notes are personal…" card ended up in the first run's side-panel
 * shot. Injection is idempotent per id, so removing them is stable across the
 * re-open every test performs.
 */
const TUTORIAL_ANNOTATION_IDS = ["highlight-1", "comment-1", "suggest-1", "note-1"].map(
  (suffix) => `${TUTORIAL_ANNOTATION_PREFIX}${suffix}`,
);

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

/**
 * ONE MCP client for the whole file, not one per test.
 *
 * The status pill prints " · N sessions", and the server keeps counting a
 * closed session for about a minute. With a fresh client per test, slot 06 —
 * the fifth step — photographed "5 sessions" and the hero's faint pill read
 * "10 sessions": accurate about the harness and wrong about the product, where
 * one person has one AI attached.
 */
test.beforeAll(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  mcp = new McpTestClient();
  await mcp.connect();
});

test.afterAll(async () => {
  await mcp.close();
});

test.beforeEach(async () => {
  // Start with a clean slate — close anything previous tests left open.
  await cleanupAllOpenDocuments(mcp);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-shot-"));
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── MCP seeding helpers ──────────────────────────────────────────────────────

/**
 * Remove one annotation. `NOT_FOUND` is tolerated and nothing else is.
 *
 * This is the one place a missing annotation is not a defect: the tutorial ids
 * are removed unconditionally without first checking whether injection actually
 * placed them (it skips a definition whose target prose has moved), and the
 * carry-over sweep races nothing. Any OTHER failure — a gated tool, a closed
 * document — means the slate is not clean and the next shot would photograph
 * the residue, so it throws.
 *
 * A user-private record (the tutorial's note, a user highlight) is refused to
 * Claude by design (ADR-027), so it goes through the route the user's
 * own Archive button uses instead.
 */
async function removeAnnotation(documentId: string, id: string): Promise<void> {
  // The parameter is `id`, not `annotationId` (src/server/mcp/annotations.ts).
  // Every step in this file routes through this helper's caller, so the wrong
  // name failed all twelve at once — which is how we learned this pipeline had
  // never actually run.
  const res = (await mcp.callTool("tandem_removeAnnotation", { id, documentId })) as Envelope;
  if (res.error && res.code === "INVALID_ARGUMENT" && res.message?.includes("user-private")) {
    const archive = await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/remove-annotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotationId: id, documentId }),
    });
    if (!archive.ok) {
      throw new Error(`Archive of ${id} failed: ${archive.status} ${await archive.text()}`);
    }
    return;
  }
  if (res.error && res.code !== "NOT_FOUND") {
    throw new Error(
      `tandem_removeAnnotation(${id}) failed: ${res.code ?? ""} ${res.message ?? ""}`,
    );
  }
}

/**
 * Open `sample/welcome.md` on a GUARANTEED-EMPTY annotation slate.
 *
 * Two distinct piles have to go, and the first run of this pipeline shipped
 * both into the images:
 *
 * 1. **The tutorial set.** `openFileByPath` seeds `tutorial-*` annotations
 *    idempotently whenever the sample doc is opened (CLAUDE.md). They are
 *    instructional rather than representative. This used to *dismiss* them,
 *    which is not the same as removing them: a dismissed annotation still
 *    renders, as a card under the panel's "3 resolved" disclosure, and the
 *    private note was never touched at all because ADR-027 hides notes from
 *    `tandem_getAnnotations`. Slot 01 asserted 4 cards and found 8.
 * 2. **The previous test's seed.** Annotations are DURABLE — keyed by file
 *    path in the annotation store, not by the document being open — so
 *    `cleanupAllOpenDocuments` does not clear them and every re-open restores
 *    them. Each test added four more on top: slot 03 ran third and photographed
 *    three identical copies of every card, thirteen pending in total.
 *
 * Removal is what fixes both, and it is durable in the right direction: the
 * Y.Map delete records a tombstone, so a removed annotation does not come back
 * on the next open.
 */
async function openWelcome(): Promise<string> {
  const res = (await mcp.callTool("tandem_open", { filePath: welcomePath })) as Envelope;
  const documentId = res.data?.documentId as string | undefined;
  if (!documentId) throw new Error(`tandem_open returned no documentId: ${JSON.stringify(res)}`);

  for (const id of TUTORIAL_ANNOTATION_IDS) await removeAnnotation(documentId, id);

  const anns = (await mcp.callTool("tandem_getAnnotations", { documentId })) as Envelope;
  const list = (anns.data?.annotations ?? []) as Array<{ id?: string }>;
  for (const ann of list) {
    if (ann.id) await removeAnnotation(documentId, ann.id);
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

/**
 * Seed slot 11 with four anchors that all sit in the FIRST SCREENFUL.
 *
 * The margin view places each bubble at its anchor's y, so a seed set is only
 * usable there if the anchors share a screen. `openWithAnnotations`' set does
 * not: measured at 1600x1000 its bubbles land at document y 469, 1269, 2011 and
 * 2110, so three of the four are below the fold and slot 11's first capture was
 * a near-empty margin holding one lone card — assertions all green, because
 * "the first bubble is visible" is true when the other three are off-screen.
 * That set is right for slot 03, which is a shot of a LIST and shows every card
 * regardless of where it is anchored.
 *
 * The last two anchors are deliberately ~65px apart, closer than a card is
 * tall. The resulting collision push is what makes a leader line legible: an
 * uncrowded bubble sits level with its anchor, so its bezier is a 24px
 * near-horizontal hairline, while a displaced one draws the visible diagonal
 * the slot's caption promises.
 */
async function openWithMarginAnnotations(): Promise<string> {
  const documentId = await openWelcome();
  const text = await documentText(documentId);

  const pasteText = "no copy-paste needed";
  await annotate({
    ...findRange(text, pasteText),
    text: "This is the sentence that lands the whole pitch.",
    textSnapshot: pasteText,
  });

  const openerText = "Both you and your AI can see and edit this document at the same time";
  await annotate({
    ...findRange(text, openerText),
    text: "Great opening line — sets collaborative expectations immediately.",
    textSnapshot: openerText,
  });

  const marksText = "your color-coded marks (yellow, green, blue, pink)";
  await annotate({
    ...findRange(text, marksText),
    text: "Worth naming which colour carries which meaning.",
    textSnapshot: marksText,
  });

  const notesText = "private thoughts kept to yourself";
  await annotate({
    ...findRange(text, notesText),
    text: "Say plainly that notes never reach the model.",
    textSnapshot: notesText,
  });

  return documentId;
}

/**
 * Mark the first-run tutorial complete before any page script runs.
 *
 * The tutorial card is `position: fixed` bottom-left and covers three lines of
 * the document. That is correct product behaviour and slot 08 exists to
 * photograph it — but in the full-viewport document shots it sits on top of the
 * prose those shots are of, so the README hero shipped its first capture with
 * the "Notes / Comments / Suggestions" bullets hidden behind it.
 *
 * `addInitScript` rather than a post-load `evaluate`: `useTutorial` reads
 * localStorage once at construction, so a write after navigation is too late —
 * the same ordering fact slot 08 relies on in the opposite direction.
 */
async function suppressTutorialCard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tandem:tutorialCompleted", "true");
    } catch {
      // Storage-disabled contexts throw on access; the card is cosmetic here.
    }
  });
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
  for (const f of files) ids.push((await openTempDocument(f.name, f.content)).id);
  return ids;
}

/** Write a Markdown file into this test's temp dir and open it. */
async function openTempDocument(
  name: string,
  content: string,
): Promise<{ filePath: string; id: string }> {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  const res = (await mcp.callTool("tandem_open", {
    filePath: filePath.replace(/\\/g, "/"),
  })) as Envelope;
  const id = res.data?.documentId as string | undefined;
  if (!id) throw new Error(`tandem_open returned no documentId for ${name}`);
  return { filePath, id };
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

/**
 * Replace this machine's account name with `you` wherever a rendered path
 * carries it.
 *
 * The wizard prints the real resolved config path for every client it finds --
 * the home-directory Claude Code settings file and three more, each carrying the
 * account name as a path segment. These images ship in a public repo, so the
 * capture must not depend on whoever runs it remembering to look. A note asking
 * for a human privacy check is not a control: it passes by default, and it
 * passes silently on the one run where nobody reads it.
 *
 * The walk is body-wide on purpose and stayed that way through #1528: on
 * loopback -- how a capture always runs -- `scrubExistingInstalls` does not
 * scrub, so a raw `readFile` error with a path in it reaches `.itc-status` and
 * `.iw-tech-text` too. What the shot renders is the viewport, not the wizard
 * element, so the walk covers the viewport.
 *
 * What changed in #1528 is the MATCH, not the scope: the old version replaced
 * the bare account name as a substring of any text node, so a capture run under
 * a `root` / `user` / `home` account rewrote ordinary UI copy. Rationale, the
 * segment-anchoring rule and the boundary trade-offs are in
 * `redact-account.ts`; it is a module so the rule is unit-testable without a
 * browser (`tests/scripts/screenshot-redaction.test.ts`).
 */
async function redactAccountName(page: Page): Promise<AccountRedactionPlan> {
  const plan = planAccountRedaction(os.homedir());
  // Returned, not swallowed: the caller's leak scan needs to know WHICH of the
  // two non-redacting outcomes this was. `scan-only` still has to scan (the
  // name is real, it just cannot be anchored); `none` must not (the account is
  // already `you`, so every redacted path on the page would report).
  if (plan.kind !== "redact") return plan;
  // A Playwright evaluate callback is serialized to source and cannot reach
  // module scope, so `redactHomePaths`'s one-line body is repeated here rather
  // than imported. `String.replace` with a `g` regex resets `lastIndex` itself,
  // so the shared instance is safe across nodes.
  //
  // Kept free of TypeScript-only syntax on purpose: the walk is the one half of
  // the redaction that needs a DOM, and `tests/scripts/screenshot-redaction.test.ts`
  // lifts this callback body out of this file verbatim and runs it against a
  // happy-dom document. A type annotation or an `as` cast here would make that
  // extraction fail (loudly — the test throws rather than skipping).
  await page.evaluate((r) => {
    const re = new RegExp(r.pattern, r.flags);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    for (const node of hits) {
      const before = node.nodeValue ?? "";
      const after = before.replace(re, r.replacement);
      if (after !== before) node.nodeValue = after;
    }
  }, plan.redaction);
  return plan;
}

/**
 * Load the app and wait until the status pill has settled on "Synced".
 *
 * Until #2258 the page's FIRST connect counted as a reconnect, so for two
 * seconds after load the pill read "Reconnected" and every shot that included
 * it (slot 06 is nothing else) photographed that transient. The pill no longer
 * does that; the wait stays as a harmless guard on the steady state.
 */
async function loadEditor(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await dismissReadOnlyBanner(page);
  await expect(page.locator("[data-status-focus-root]")).toContainText("Synced", {
    timeout: 10_000,
  });
}

/**
 * Collapse the side panel's filter bar.
 *
 * `switchToAnnotationsTab` EXPANDS it, because the e2e specs that share the
 * helper want the filter controls. In a picture of annotation cards those three
 * rows of chips are the first thing the eye lands on, and they cost the hero
 * the suggestion card's Accept/Dismiss row.
 */
async function collapseFilterBar(page: Page): Promise<void> {
  const toggle = page.getByTestId("filter-bar-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

/**
 * Drop focus from whatever holds it. Closing a menu or modal returns focus to
 * the control that opened it — the brand logo — and a shot taken then carries
 * its focus ring.
 */
async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * Wait until every CSS animation and transition inside `target` has finished.
 * `toBeVisible` passes on an entrance animation's first frame, when the element
 * is still nearly transparent — slots 07 and 21 both photographed that.
 */
async function waitForAnimations(target: Locator): Promise<void> {
  await expect
    .poll(() =>
      target.evaluate((el) =>
        el.getAnimations({ subtree: true }).every((a) => a.playState === "finished"),
      ),
    )
    .toBe(true);
}

/** Load the app, wait for the editor + first annotation card, settle animations. */
async function gotoAnnotatedEditor(page: Page): Promise<void> {
  await loadEditor(page);
  await switchToAnnotationsTab(page);
  await collapseFilterBar(page);
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
  // The hero is a shot of the document; the tutorial card covers three lines of
  // it. Slot 08 is where that card gets photographed.
  await suppressTutorialCard(page);
  await gotoAnnotatedEditor(page);

  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(4, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("mode-toggle")).toBeVisible();

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
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

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
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
  //
  // Asserted against the diff's STRUCTURE, not against the proposed sentence as
  // a contiguous string. `SuggestionCard` renders `diffWords(textSnapshot,
  // suggestedText)`, so the two versions are interleaved word by word — the DOM
  // reads "The projectIn launchedearly in2025, earlythe 2025project withset
  // three coreambitious goals", and a `toContainText` on the whole proposed
  // sentence could never pass while a `textSnapshot` is present. (It would pass
  // against the no-snapshot fallback branch further down that component, which
  // is presumably where the string came from.) These four checks are what the
  // README slot actually promises, and they are strictly harder to satisfy.
  // Scrolled fully into frame first. An element screenshot captures the list's
  // box, not its scroll extent, so a card sitting past the fold is photographed
  // sliced in half — the first passing run caught the suggestion card at its
  // header, with the diff the slot exists for cut off two pixels below.
  const suggestionCard = list
    .locator("[data-testid^='annotation-card-']")
    .filter({ has: page.locator("[data-testid^='suggestion-diff-']") })
    .first();
  await expect(suggestionCard).toBeVisible({ timeout: 10_000 });
  await suggestionCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const diff = suggestionCard.locator("[data-testid^='suggestion-diff-']");
  await expect(diff).toBeVisible({ timeout: 10_000 });
  // Red strikethrough on the removed words, green on the proposed ones. Both
  // are inline styles on the diff's own spans, hence the attribute match.
  await expect(diff.locator("span[style*='line-through']").first()).toBeVisible();
  await expect(diff.locator("span[style*='success-fg-strong']").first()).toBeVisible();
  // The proposed wording landed rather than only the deletion rendering.
  await expect(diff).toContainText("ambitious");
  await expect(suggestionCard.locator("[data-testid^='accept-btn-']")).toBeVisible();
  await expect(suggestionCard.locator("[data-testid^='dismiss-btn-']")).toBeVisible();

  // Whole card inside the captured box, top and bottom. This is the assertion
  // the cropped first run lacked: every check above passed against a card whose
  // Accept/Reject row was below the frame.
  const listBox = await list.boundingBox();
  const cardBox = await suggestionCard.boundingBox();
  if (!listBox || !cardBox) throw new Error("annotation list or suggestion card has no box");
  expect(cardBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await list.screenshot({ path: path.join(screenshotsDir, "03-side-panel.png") });
});

test("04-toolbar-actions", async ({ page }) => {
  const welcomeId = await openWithAnnotations();
  const [budgetId] = await openExtraDocuments();

  await mcp.callTool("tandem_switchDocument", { documentId: welcomeId });

  await loadEditor(page);

  // The dirtying edit lands AFTER the page is up and the tab has armed, and
  // that ordering is the whole trick. `dirty` is not server state: TabItem
  // inlines `useTabDirty`, which observes its own Y.Doc fragment and arms on a
  // 500ms timer that RESETS `dirty = false` when it fires — deliberately, so
  // the initial Hocuspocus sync isn't mistaken for a user edit. Appending
  // before `page.goto` therefore put the change inside that initial sync, and
  // the tab loaded permanently clean over a document that had never been
  // written to disk. Waiting past the arm window and then editing is the only
  // way a browser observes the transition at all.
  await page.waitForTimeout(900);
  await mcp.callTool("tandem_appendContent", {
    documentId: budgetId,
    content: "\n## Outlook\n\nQ4 forecast pending finance review.\n",
  });

  await selectFirstParagraph(page);

  // Everything the two captions promise, asserted rather than hoped for.
  await expect(page.locator("[data-testid^='tab-']")).not.toHaveCount(0);
  // The DIRTY tab's dot, addressed by document id. `unsaved-indicator-*` is a
  // fixed-width slot TabItem renders on every tab so the dot/check/empty states
  // can't shift the strip — on a clean tab it is an empty span with no box, so
  // `.first()` resolved the (clean, active) welcome tab and waited ten seconds
  // for something that is hidden by design. `budgetId` is the one we dirtied
  // with `tandem_appendContent`, and `.dot` is the ● itself rather than the
  // slot holding it.
  await expect(page.locator(`[data-testid='unsaved-indicator-${budgetId}'] .dot`)).toBeVisible({
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
  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
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
  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await pill.screenshot({ path: path.join(screenshotsDir, "06-claude-presence.png") });
});

/**
 * Report a configured Claude Code integration. The harness backend has none,
 * so without this the Claude Code tab leads with the "No AI connected yet"
 * callout while the same frame's status pill reads "AI attached" (the e2e
 * client IS attached) — a contradiction a reader cannot resolve.
 */
async function stubClaudeCodeIntegration(page: Page): Promise<void> {
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
}

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
  await stubClaudeCodeIntegration(page);
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
  await loadEditor(page);

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
  // Close Settings before the shot so the clip shows the toast over the page,
  // not over the modal's 70% backdrop. (Until #2257 the toast also painted
  // UNDER that backdrop, as a pale ghost; it now sits above every modal.) The
  // toast outlives the modal by design. Closed with
  // its button, not Escape: the modal's Escape handler acts only while focus is
  // inside it, and after Save focus is not guaranteed to be.
  await page.getByTestId("settings-modal-close-btn").click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await expect(toast).toContainText("Working directory saved.");
  // And wait out the 200ms slide-in: `toBeVisible` passes on its first frame.
  await waitForAnimations(toast);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
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

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: path.join(screenshotsDir, "08-onboarding-tutorial.png") });
});

test("09-settings-modal", async ({ page }) => {
  await stubClaudeCodeIntegration(page);
  await openWelcome();
  // A full-viewport shot: the tutorial card sits bottom-left, half under the
  // modal's backdrop and half beside it, and read as part of Settings.
  await suppressTutorialCard(page);
  await loadEditor(page);
  const modal = await openSettingsClaudeCodeTab(page);
  await expect(modal).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId("settings-modal-tab-claude-code")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("tutorial-dismiss-btn")).toHaveCount(0);
  await expect(page.getByTestId("settings-modal-working-directory")).toBeVisible({
    timeout: 5_000,
  });
  await expect(modal).not.toContainText("No AI connected yet");
  await page.waitForTimeout(300);
  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "09-settings-modal.png"),
    fullPage: false,
  });
});

test("10-solo-tandem-toggle", async ({ page }) => {
  await openWelcome();
  await loadEditor(page);

  const toggle = page.getByTestId("mode-toggle");
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  // Both options must be legible — a close-up of one half is not the control.
  await expect(page.getByTestId("mode-solo-btn")).toBeVisible();
  await toggle.hover();
  await page.waitForTimeout(300);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await toggle.screenshot({ path: path.join(screenshotsDir, "10-solo-tandem-toggle.png") });
});

test("11-margin-annotations", async ({ page }) => {
  // Margin view is opt-in AND width-gated. Both must be satisfied, and the
  // width must be ASSERTED, not assumed: below the `full` threshold the ladder
  // silently steps down to `narrow` (no action row) or `stub` (a pip), and the
  // shot degrades into something that does not show what the caption claims.
  await page.setViewportSize({ width: 1600, height: 1000 });
  // Slot 11's own above-the-fold seed — see `openWithMarginAnnotations`.
  await openWithMarginAnnotations();
  await suppressTutorialCard(page);
  await loadEditor(page);

  // Open rails feed the auto-hide threshold; close both so `full` is reachable.
  await setRailVisible(page, "left", false);
  await setRailVisible(page, "right", false);

  await openSettingsClaudeCodeTab(page);
  const marginToggle = page.locator("[data-testid='settings-modal-margin-view-toggle'] input");
  if (!(await marginToggle.isChecked())) await marginToggle.click();
  await expect(marginToggle).toBeChecked();
  await page.keyboard.press("Escape");
  await blurActiveElement(page);

  // `margin-column-right` is asserted ATTACHED, never visible. Every bubble it
  // holds is `position: absolute`, so the column contributes no height of its
  // own and Playwright reports it `hidden` in every state including a perfectly
  // rendered full-width margin — the first run burned ten seconds proving that
  // against a column the locator had already resolved thirteen times. The
  // bubbles are the visible surface, and they are what the shot is of.
  const column = page.locator("[data-testid='margin-column-right']");
  await expect(column).toBeAttached({ timeout: 10_000 });
  const bubble = page.locator("[data-testid^='margin-bubble-']").first();
  await expect(bubble).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-testid='margin-anchor-dot']").first()).toBeVisible();
  // `full` is 240px; `narrow` is 160 and `stub` is 28. This is the assertion
  // that stops a degraded ladder state shipping as a full-margin screenshot.
  // Measured on the bubble, which is `width: 100%` of the column — same number,
  // from an element that actually has a box.
  const bubbleBox = await bubble.boundingBox();
  if (!bubbleBox) throw new Error("margin bubble has no bounding box");
  expect(bubbleBox.width).toBeGreaterThanOrEqual(MARGIN_FULL_COLUMN_PX);

  // The margin must actually LOOK like a margin. Bubbles are placed at their
  // anchor's y down the whole scroll height, so "a bubble exists and is
  // visible" is satisfied by a frame containing exactly one card and three
  // off-screen ones — which is the picture the first passing run produced.
  // Count the ones inside the captured viewport instead.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  const inFrame = await page.locator("[data-testid^='margin-bubble-']").evaluateAll(
    (els, h) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= h && r.height > 0;
      }).length,
    viewport.height,
  );
  expect(inFrame).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(500);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "11-margin-annotations.png"),
    fullPage: false,
  });
});

test("12-outline-rail", async ({ page }) => {
  await openWelcome();
  // Before `goto`: this installs an init script, so it has no effect on a page
  // that has already navigated. The tutorial card is anchored bottom-left and
  // overlaps the outline rail, which is the one element this shot exists to
  // show. It survived the first capture because every assertion below still
  // passed with a card clipped across the lower third of the frame -- passing
  // is not the same as depicting the subject.
  await suppressTutorialCard(page);
  await loadEditor(page);
  await setRailVisible(page, "left", true);

  const rail = page.getByTestId("left-outline-rail");
  await expect(rail).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("outline-panel")).toBeVisible();
  await expect(page.getByTestId("outline-search-input")).toBeVisible();
  // welcome.md carries six headings across two levels; a flat document would
  // produce a technically-correct screenshot of an empty tree.
  await expect(page.locator("[data-testid^='outline-heading-']")).not.toHaveCount(0);
  // Pin the suppression, or a future change to the completion key silently
  // restores the overlap and nothing here notices.
  await expect(page.getByTestId("tutorial-dismiss-btn")).toHaveCount(0);
  await page.waitForTimeout(400);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await rail.screenshot({ path: path.join(screenshotsDir, "12-outline-rail.png") });
});

test("13-setup-wizard", async ({ page }) => {
  // The wizard CANNOT be reached through first-run here: the root
  // playwright.config.ts sets TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV=1 before
  // `defineConfig`, and the screenshots config spreads that base. Waiting for a
  // first-run wizard would look like an unexplained timeout. The manual reopen
  // entry point is deterministic and leaves first-run state alone.
  //
  // PRIVACY: this shot has always rendered the capture machine's OWN config --
  // `detectTargets` reads `os.homedir()` directly, so it is not bounded by
  // `TANDEM_APP_DATA_DIR`, and every detected client's resolved path (account
  // name included) landed in the PNG. That exposure predates #1422; the
  // machine-dependence was the point of `redactAccountName` and of the
  // assertion after it, which is a text-substitution pass over whatever
  // happened to be on screen.
  //
  // #1422 is the occasion for fixing it properly, not the cause: once the card
  // surfaces `EntryValidation.reason`, a broken entry in the capture machine's
  // own `~/.claude.json` would put a second machine-dependent string on screen,
  // which a redaction pass keyed on the account name would not catch at all.
  // Route-stubbing `GET /api/integrations/existing` removes the whole class at
  // the source: the wizard renders a fixed fixture instead of this machine's
  // real config, on this machine and any other that ever runs this capture.
  // `redactAccountName` and the assertion after it stay on as defense in depth
  // for anything ELSE in the settings modal that might echo a real path -- do
  // not downgrade either into a note asking a human to check, which is what
  // this step relied on before the stub existed.
  await page.route("**/api/integrations/existing", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          installs: [
            {
              target: {
                label: "Claude Code",
                configPath: "/Users/you/.claude.json",
                kind: "claude-code",
              },
              status: "ok",
              tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
              tandemValidation: { status: "valid" },
            },
            {
              target: {
                label: "Claude Desktop",
                configPath:
                  "/Users/you/Library/Application Support/Claude/claude_desktop_config.json",
                kind: "claude-desktop",
              },
              status: "missing",
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await openWelcome();
  await loadEditor(page);

  await openSettingsClaudeCodeTab(page);
  await page.getByTestId("settings-modal-open-integration-wizard").click();

  const wizard = page.getByTestId("integration-wizard");
  await expect(wizard).toBeVisible({ timeout: 10_000 });
  const cards = page.locator("[data-testid^='integration-wizard-card-']");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  // Pin the fixture's two status lines. Belt-and-suspenders alongside the
  // stub above: if a future change to the card's status derivation ever
  // widens what renders here, this fails loudly instead of silently shipping
  // whatever the fixture happened to produce.
  await expect(page.locator(".itc-status").nth(0)).toHaveText(
    "Already connected — we'll refresh it",
  );
  await expect(page.locator(".itc-status").nth(1)).toHaveText(
    "Ready to connect (settings file will be created)",
  );
  await page.waitForTimeout(400);

  const plan = await redactAccountName(page);
  if (plan.kind === "redact") {
    // Prove the redaction reached the DOM rather than trusting that it ran.
    // `.itc-path` is the element that always prints a resolved path (the
    // wizard's other path carriers -- `.itc-status`, `.iw-tech-text` -- only
    // appear on an error), so an empty match here would mean the paths moved
    // out of text nodes -- a real finding, not a reason to ship the shot
    // anyway. Guarded because the other two outcomes rewrite nothing: on a
    // machine whose account is already `you` there is nothing to prove, and on
    // an unanchorable home directory the scan below is the whole control.
    await expect(page.locator(".itc-path").first()).toContainText("you");
  }
  // And prove nothing leaked. This scans the whole rendered viewport -- what the
  // shot actually captures, which is wider than the `wizard` element the old
  // assertion checked -- for any path-shaped run of text that still carries the
  // account name. Unlike a bare `not.toContainText` on the name, it cannot be
  // satisfied by corrupting prose that merely uses the word -- which is exactly
  // how #1528's over-replacement passed review. A hit is a reason to stop, not
  // to publish.
  //
  // The plan goes in whole rather than a bare account name re-derived from the
  // home directory: the scan needs the redaction's own parent prefix to avoid
  // reporting its own output on a `/home/home` machine, and it needs `none` to
  // mean "do not scan at all".
  const leaks = findAccountPathLeaks(await page.locator("body").innerText(), plan);
  expect(leaks, `account name survived in rendered path(s): ${leaks.join(", ")}`).toEqual([]);

  // Gate 3 (#1453 review): font barrier -- swap-loaded faces must be settled
  // before the pixel capture, not just after a fixed sleep.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "13-setup-wizard.png"),
    fullPage: false,
  });
});

// ── Slots 15+ ────────────────────────────────────────────────────────────────

/**
 * Slots 15 and 16: slot 01's seed and framing, re-themed through the brand
 * menu's colour-scheme swatch — the control a reader will actually use. The
 * attribute assertion is what proves the switch happened: a light frame is a
 * perfectly plausible-looking screenshot.
 */
async function captureThemedOverview(page: Page, theme: "dark" | "warm", file: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openWithAnnotations();
  await suppressTutorialCard(page);
  await gotoAnnotatedEditor(page);

  await page.getByTestId("titlebar-brand-menu").click();
  // Choosing a swatch closes the menu, so the proof of the switch is the
  // attribute on <html> below, not the swatch's own `aria-checked`.
  await page.getByTestId(`brand-menu-theme-${theme}`).click();
  const popover = page.getByTestId("titlebar-brand-menu-popover");
  if (await popover.isVisible()) await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await blurActiveElement(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(4);
  await expect(page.getByTestId("mode-toggle")).toBeVisible();
  // The theme swap is a CSS-variable change with colour transitions on it.
  await page.waitForTimeout(500);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(screenshotsDir, file), fullPage: false });
}

test("15-dark-theme", async ({ page }) => {
  await captureThemedOverview(page, "dark", "15-dark-theme.png");
});

test("16-warm-theme", async ({ page }) => {
  await captureThemedOverview(page, "warm", "16-warm-theme.png");
});

test("17-reply-thread-and-note", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const documentId = await openWelcome();
  const text = await documentText(documentId);

  // The thread: Claude's comment, the user's reply, Claude's answer. The user
  // half goes through the card's own Reply button, because that is the path
  // the screenshot claims exists.
  const openerText = "Both you and your AI can see and edit this document at the same time";
  const created = (await mcp.callTool("tandem_comment", {
    ...findRange(text, openerText),
    text: "Great opening line — sets collaborative expectations immediately.",
    textSnapshot: openerText,
  })) as Envelope;
  const commentId = created.data?.annotationId as string | undefined;
  if (created.error || !commentId) {
    throw new Error(`tandem_comment failed: ${created.code ?? ""} ${created.message ?? ""}`);
  }

  await suppressTutorialCard(page);
  await loadEditor(page);
  await switchToAnnotationsTab(page);
  await collapseFilterBar(page);

  const commentCard = page.getByTestId(`annotation-card-${commentId}`);
  await expect(commentCard).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`reply-btn-${commentId}`).click();
  await page
    .getByTestId(`reply-input-${commentId}`)
    .fill("Should it say that edits sync both ways, not just that we can both see it?");
  await page.getByTestId(`reply-send-btn-${commentId}`).click();
  // Both replies are timestamped by the server on arrival and the thread sorts
  // by timestamp, so Claude's answer must not be sent until the user's question
  // has landed — otherwise the answer can render above the question it answers.
  await expect(page.getByTestId(`reply-toggle-${commentId}`)).toContainText("1 reply", {
    timeout: 10_000,
  });

  const reply = (await mcp.callTool("tandem_annotationReply", {
    annotationId: commentId,
    documentId,
    text: "Yes — that's the stronger claim. I'd add “and every edit appears for both of you as it happens.”",
  })) as Envelope;
  if (reply.error) {
    throw new Error(`tandem_annotationReply failed: ${reply.code ?? ""} ${reply.message ?? ""}`);
  }

  // The private note. Claude cannot create one (ADR-027 — there is no MCP path
  // to a note at all), so it is made the way a user makes it: select text, open
  // the selection popup's composer, choose "Note to self".
  const notesItem = page.locator(".ProseMirror li", {
    hasText: "private thoughts kept to yourself",
  });
  await selectTextStable(notesItem);
  await openAnnotatePopup(page);
  await page
    .getByTestId("popup-annotation-input")
    .fill("Check whether a note can be promoted to a comment later.");
  await submitAnnotation(page, "note");

  const noteCard = page
    .locator("[data-testid^='annotation-card-']")
    .filter({ has: page.getByTestId("annotation-private-pill") });
  await expect(noteCard).toBeVisible({ timeout: 10_000 });

  // Remove the note in a `finally`, before the next step reopens welcome.md.
  // `openWelcome`'s sweep lists through `tandem_getAnnotations`, which never
  // returns a note (ADR-027) — the same blind spot `TUTORIAL_ANNOTATION_IDS`
  // exists for — so a note left behind survives into every later shot of the
  // document (the first full run put it behind slot 22's Settings modal). A
  // failed assertion below must not leave it there either.
  const noteTestId = await noteCard.getAttribute("data-testid");
  const noteId = noteTestId?.replace(/^annotation-card-/, "");
  if (!noteId) throw new Error("note card carries no annotation id");
  try {
    await expect(noteCard).toContainText("promoted to a comment");

    // Threads start collapsed; the toggle's count proves both replies landed.
    const toggle = page.getByTestId(`reply-toggle-${commentId}`);
    await expect(toggle).toContainText("2 replies", { timeout: 10_000 });
    await toggle.click();
    const thread = commentCard.getByTestId("comment-thread");
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("edits sync both ways");
    await expect(thread).toContainText("the stronger claim");

    // Clear the selection so the popup is not floating over the editor, then
    // check both cards sit wholly inside the captured box (see slot 03).
    await page.keyboard.press("Escape");
    await blurActiveElement(page);
    const list = page.getByTestId("annotation-list-scroll-container");
    await commentCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const listBox = await list.boundingBox();
    if (!listBox) throw new Error("annotation list has no box");
    for (const card of [commentCard, noteCard]) {
      const box = await card.boundingBox();
      if (!box) throw new Error("annotation card has no box");
      expect(box.y).toBeGreaterThanOrEqual(listBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
    }

    await page.evaluate(() => document.fonts.ready);
    await list.screenshot({ path: path.join(screenshotsDir, "17-reply-thread-and-note.png") });
  } finally {
    await removeAnnotation(documentId, noteId);
  }
});

/**
 * Make an unsaved edit in the ACTIVE document through the editor, then wait
 * until the SERVER holds it. The tab's dirty dot is not enough: it comes from
 * the browser's own Y.Doc, so a disk write issued as soon as the dot appears can
 * race the WebSocket update. The watcher would then find a clean server
 * document and silently reload instead of raising the conflict a caller wants.
 */
async function makeUnsavedEdit(page: Page, documentId: string, typed: string): Promise<void> {
  const firstPara = page.locator(".ProseMirror p").first();
  await firstPara.click();
  await page.keyboard.press("End");
  await page.keyboard.type(typed);
  await expect(page.locator(`[data-testid='unsaved-indicator-${documentId}'] .dot`)).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => documentText(documentId), { timeout: 10_000 }).toContain(typed.trim());
}

const BRIEF_MD =
  "# Project Brief\n\nThe pilot runs for six weeks with two partner teams.\n\n## Scope\n\nWe will measure review turnaround and the share of suggestions accepted.\n\n## Risks\n\nThe second team has not confirmed its start date.\n";

test("18-external-conflict-banner", async ({ page }) => {
  const { filePath, id } = await openTempDocument("project-brief.md", BRIEF_MD);
  await suppressTutorialCard(page);
  await loadEditor(page);
  // The right rail would only frame an empty annotation list beside the banner.
  await setRailVisible(page, "right", false);
  await makeUnsavedEdit(page, id, " Draft two.");

  // Another program rewrites the file while the edit is unsaved. Autosave is a
  // single global 60s interval that also writes to disk, so a tick landing
  // between the edit and this write would clean the document and the watcher
  // would reload silently. That fails closed (the banner assertion times out);
  // it cannot produce a wrong picture.
  fs.writeFileSync(filePath, BRIEF_MD.replace("six weeks", "eight weeks"));

  const banner = page.getByTestId("external-conflict-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("changed on disk while you have unsaved edits");
  await expect(page.getByTestId("external-conflict-keep-btn")).toHaveText("Keep my edits");
  await expect(page.getByTestId("external-conflict-reload-btn")).toHaveText("Reload from file");
  await blurActiveElement(page);
  // Park the pointer off the document: left over the heading from the click,
  // it summons the heading's collapse caret.
  await page.mouse.move(700, 4);
  await page.waitForTimeout(300);

  // The top of the window: the tab with its unsaved dot, the banner, and the
  // edited paragraph under it.
  const bannerBox = await banner.boundingBox();
  if (!bannerBox) throw new Error("conflict banner has no box");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "18-external-conflict-banner.png"),
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.min(viewport.height, Math.round(bannerBox.y + bannerBox.height + 220)),
    },
  });
});

test("19-command-palette", async ({ page }) => {
  await openWelcome();
  await suppressTutorialCard(page);
  await loadEditor(page);

  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible({ timeout: 3_000 });
  await page.getByTestId("palette-input").fill("annotation");
  await expect(palette).toContainText("Next annotation");
  await expect(palette).toContainText("Accept focused annotation");
  await expect(palette.locator("[data-testid^='palette-item-']")).not.toHaveCount(0);
  await page.waitForTimeout(300);

  await page.evaluate(() => document.fonts.ready);
  await palette.screenshot({ path: path.join(screenshotsDir, "19-command-palette.png") });
});

test("20-help-modal", async ({ page }) => {
  await openWelcome();
  await suppressTutorialCard(page);
  await loadEditor(page);

  await page.getByTestId("titlebar-brand-menu").click();
  await page.getByTestId("brand-menu-shortcuts").click();
  const dialog = page.getByTestId("help-modal").getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  await expect(dialog).toContainText("Keyboard Shortcuts");
  await expect(page.getByTestId("help-modal-content")).toContainText("Toggle Solo / Tandem mode");
  await page.waitForTimeout(300);

  await page.evaluate(() => document.fonts.ready);
  await dialog.screenshot({ path: path.join(screenshotsDir, "20-help-modal.png") });
});

test("21-activity-tray", async ({ page }) => {
  // Two real events, not injected ones: a clean file rewritten on disk (an
  // info "reloaded" entry) and a dirty one (a warning conflict entry).
  const notes = await openTempDocument(
    "meeting-notes.md",
    "# Meeting Notes\n\nAgreed to ship the pilot on the first of the month.\n",
  );
  const brief = await openTempDocument("project-brief.md", BRIEF_MD);
  await suppressTutorialCard(page);
  await loadEditor(page);

  fs.writeFileSync(
    notes.filePath,
    "# Meeting Notes\n\nAgreed to ship the pilot on the second of the month.\n",
  );
  // The count badge exactly: `toContainText("1")` on the whole pill also
  // passes on "10" or "11".
  await expect(page.getByTestId("activity-pill").locator(".count")).toHaveText("1", {
    timeout: 15_000,
  });

  await makeUnsavedEdit(page, brief.id, " Draft two.");
  fs.writeFileSync(brief.filePath, BRIEF_MD.replace("six weeks", "eight weeks"));
  await expect(page.getByTestId("external-conflict-banner")).toBeVisible({ timeout: 15_000 });

  // Clear the transient pops so they are not stacked over the tray. Dismissing
  // a pop leaves its tray entry, which is the point of the tray.
  const dismiss = page.locator("[data-testid^='toast-dismiss-']");
  await expect(dismiss).not.toHaveCount(0, { timeout: 5_000 });
  // Each click must take a toast away; one that does not fails here rather
  // than spinning until the test timeout.
  for (let n = await dismiss.count(); n > 0; n = await dismiss.count()) {
    await dismiss.first().click();
    await expect(dismiss).toHaveCount(n - 1);
  }

  const pill = page.getByTestId("activity-pill");
  await pill.click();
  const tray = page.getByTestId("activity-tray");
  await expect(tray).toBeVisible();
  const rows = tray.locator("[data-testid^='activity-row-']");
  await expect(rows).toHaveCount(2);
  // The rows cascade in from opacity 0; the first passing run photographed an
  // open tray with both rows still invisible.
  await waitForAnimations(tray);
  await expect(rows.nth(0)).toBeVisible();
  await expect(rows.nth(1)).toBeVisible();
  await expect(tray).toContainText("reloaded: meeting-notes.md");
  await expect(tray).toContainText("project-brief.md changed on disk");
  await expect(page.getByTestId("activity-clear-all")).toBeVisible();
  await blurActiveElement(page);
  await page.waitForTimeout(400);

  // The tray and its pill together, with a margin.
  const trayBox = await tray.boundingBox();
  const pillBox = await pill.boundingBox();
  if (!trayBox || !pillBox) throw new Error("activity tray or pill has no box");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No viewport");
  const pad = 16;
  const x = Math.max(0, Math.min(trayBox.x, pillBox.x) - pad);
  const y = Math.max(0, Math.min(trayBox.y, pillBox.y) - pad);
  const right = Math.min(
    viewport.width,
    Math.max(trayBox.x + trayBox.width, pillBox.x + pillBox.width) + pad,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(trayBox.y + trayBox.height, pillBox.y + pillBox.height) + pad,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "21-activity-tray.png"),
    clip: { x, y, width: right - x, height: bottom - y },
  });
});

test("22-settings-notifications", async ({ page, context, baseURL }) => {
  // The tab's first line reports the browser's notification permission, and
  // the shot should show the settled "allowed" state rather than a prompt or a
  // block the reader may never see. `grantPermissions` is the real lever, but
  // the headless shell this pipeline runs reports `Notification.permission` as
  // "denied" whatever is granted — so the BROWSER's answer is stubbed before
  // any page script runs, the same way slot 13 stubs the machine's config.
  // Nothing in Tandem is stubbed: the tab renders its own granted branch.
  await context.grantPermissions(["notifications"], { origin: baseURL });
  await page.addInitScript(() => {
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
    }
  });
  await openWelcome();
  await suppressTutorialCard(page);
  await loadEditor(page);

  await openSettingsViaBrandMenu(page);
  const modal = page.getByTestId("settings-modal");
  await expect(modal).toBeVisible({ timeout: 3_000 });
  const hamburger = page.getByTestId("settings-modal-narrow-hamburger");
  if (await hamburger.isVisible().catch(() => false)) await hamburger.click();
  await page.getByTestId("settings-modal-tab-notifications").click();
  await expect(page.getByTestId("settings-modal-tab-notifications")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("notifications-permission-status")).toHaveText(
    "This browser allows Tandem's notifications.",
  );
  await expect(page.getByTestId("notifications-enable-toggle")).toBeVisible();
  await expect(page.getByTestId("notifications-sound-select")).toBeVisible();

  // The modal is a fixed 900x680 with a scrolling body (docs/gotchas.md), so
  // the last control must be inside the visible body, not merely rendered.
  const body = page.getByTestId("settings-modal-content");
  const lastControl = page.getByTestId("notifications-test-button");
  await lastControl.scrollIntoViewIfNeeded();
  const bodyBox = await body.boundingBox();
  const lastBox = await lastControl.boundingBox();
  if (!bodyBox || !lastBox) throw new Error("settings body or test button has no box");
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
  await page.waitForTimeout(300);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(screenshotsDir, "22-settings-notifications.png"),
    fullPage: false,
  });
});
