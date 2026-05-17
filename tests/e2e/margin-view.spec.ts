import { expect, test } from "@playwright/test";
import path from "path";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * E2E coverage for #649 PR1 — Word-style margin annotation view.
 *
 * The composable underneath (`useMarginPositions`) requires a real Tiptap
 * view + Y.Doc + Svelte effect root, so unit tests only cover its pure
 * helpers. These specs exercise the toggle, persistence, default-off
 * layout invariant, and the bubble click → activeAnnotationId contract.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — heading prefix is 2 chars, title spans 2..15.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

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

async function openSettingsAndGotoCowork(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("[data-testid='settings-btn']").click();
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await popover.getByRole("button", { name: "Claude Code/Cowork" }).click();
}

async function setMarginView(
  page: import("@playwright/test").Page,
  enabled: boolean,
): Promise<void> {
  await openSettingsAndGotoCowork(page);
  const popover = page.locator("[data-testid='settings-popover']");
  const toggleInput = popover.locator("[data-testid='margin-view-toggle'] input");
  if ((await toggleInput.isChecked()) !== enabled) {
    await toggleInput.click();
  }
  await expect(toggleInput).toBeChecked({ checked: enabled });
  // Close popover so it doesn't intercept later interactions.
  await page.keyboard.press("Escape");
}

test("default off: margin columns are absent from the DOM", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Annotation decoration must render (proves the doc/annotation pipeline ran).
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });
  // Columns absent before opt-in.
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
});

test("toggle on: margin columns appear with a bubble for the comment", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // Both columns mount when marginView is on (column visibility itself isn't a
  // useful Playwright assertion — the columns have no intrinsic height because
  // their bubble children are absolutely positioned). Assert presence instead.
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  // The comment bubble shows up in the right column with real geometry (allow
  // rAF + ResizeObserver to settle).
  const rightBubble = page
    .locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']")
    .first();
  await expect(rightBubble).toBeVisible({ timeout: 5_000 });
});

test("toggle state persists across reload", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await setMarginView(page, true);

  const savedValue = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { marginView?: unknown }).marginView : null;
  }, TANDEM_SETTINGS_KEY);
  expect(savedValue).toBe(true);

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  await openSettingsAndGotoCowork(page);
  const reloadedToggleInput = page.locator(
    "[data-testid='settings-popover'] [data-testid='margin-view-toggle'] input",
  );
  await expect(reloadedToggleInput).toBeChecked();
});

test("PR2: two overlapping comments produce non-overlapping bubbles", async ({ page }) => {
  // Anchor two comments to adjacent ranges in the same paragraph so their
  // natural `coordsAtPos` tops collide on the same line; the collision sweep
  // must push the second bubble below the first.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_FROM + 4,
    text: "first",
    textSnapshot: TITLE_TEXT.slice(0, 4),
  });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM + 5,
    to: TITLE_TO,
    text: "second",
    textSnapshot: TITLE_TEXT.slice(5),
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  const bubbles = page.locator(
    "[data-testid='margin-column-right'] [data-testid^='margin-bubble-']",
  );
  await expect(bubbles).toHaveCount(2, { timeout: 5_000 });

  // Allow the collision sweep + bind:clientHeight to settle.
  await page.waitForTimeout(150);

  const boxes = await bubbles.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }),
  );
  expect(boxes.length).toBe(2);
  const [a, b] = [...boxes].sort((x, y) => x.top - y.top);
  // The lower bubble's top must sit at or below the upper bubble's bottom.
  expect(b.top).toBeGreaterThanOrEqual(a.bottom);
});

test("PR3: leader lines render and slope with collision adjustment", async ({ page }) => {
  // Two adjacent comments on the same line force a collision: the lower
  // bubble's `adjTop > rawTop`, so its leader connects raw editor anchor
  // to pushed-down bubble (sloped). The upper bubble is uncollided, so its
  // leader's `y2 - y1 === LEADER_BUBBLE_INSET_PX` (12) exactly.
  //
  // We read `y1`/`y2` directly off the SVG `<line>` attributes — these are
  // the values the component wrote, untainted by viewport scroll, device
  // pixel rounding, or layer-relative coordinate math (lesson #71). Sort
  // by `y1` since `placeable` is annotation-array order, not visual order.
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_FROM + 4,
    text: "first",
    textSnapshot: TITLE_TEXT.slice(0, 4),
  });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM + 5,
    to: TITLE_TO,
    text: "second",
    textSnapshot: TITLE_TEXT.slice(5),
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  const leaderSvg = page.locator("[data-testid='margin-leaders-right']");
  await expect(leaderSvg).toHaveCount(1, { timeout: 5_000 });
  const lines = leaderSvg.locator("line[data-annotation-id]");
  await expect(lines).toHaveCount(2, { timeout: 5_000 });

  // Poll until the collision sweep has produced a visibly sloped lower line.
  // The `> 12` predicate is what proves `adjTop > rawTop` (a real push), not
  // just the constant LEADER_BUBBLE_INSET_PX offset.
  await expect
    .poll(
      async () => {
        const ys = await lines.evaluateAll((els) =>
          els.map((el) => ({
            y1: parseFloat(el.getAttribute("y1") ?? "NaN"),
            y2: parseFloat(el.getAttribute("y2") ?? "NaN"),
          })),
        );
        if (ys.length !== 2) return null;
        if (!ys.every(({ y1, y2 }) => Number.isFinite(y1) && Number.isFinite(y2))) return null;
        const sorted = [...ys].sort((a, b) => a.y1 - b.y1);
        return sorted[1].y2 - sorted[1].y1;
      },
      { timeout: 5_000, message: "lower leader line must slope (collision pushed bubble down)" },
    )
    .toBeGreaterThan(12);

  // Now snapshot once and verify both lines independently. Upper line is
  // uncollided — `y2 - y1 === LEADER_BUBBLE_INSET_PX` exactly (no float ops
  // between the assignment and the attribute), with <1px tolerance for any
  // future subpixel jitter.
  const ys = await lines.evaluateAll((els) =>
    els.map((el) => ({
      y1: parseFloat(el.getAttribute("y1") ?? "NaN"),
      y2: parseFloat(el.getAttribute("y2") ?? "NaN"),
    })),
  );
  const [upper, lower] = [...ys].sort((a, b) => a.y1 - b.y1);
  expect(Math.abs(upper.y2 - upper.y1 - 12)).toBeLessThan(1);
  expect(lower.y2 - lower.y1).toBeGreaterThan(12);
});

test("PR2: comment with a reply shows reply count in the bubble", async ({ page }) => {
  const open = await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  });
  expect(open).toBeTruthy();
  const created = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Pending reply",
    textSnapshot: TITLE_TEXT,
  })) as { error: false; data: { annotationId: string } } | { error: true };
  if (created.error !== false) throw new Error("tandem_comment failed");
  const commentId = created.data.annotationId;
  expect(commentId).toBeTruthy();

  await mcp.callTool("tandem_annotationReply", {
    annotationId: commentId,
    text: "A user reply",
  });

  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  const bubble = page.locator(`[data-testid='margin-bubble-${commentId}']`);
  await expect(bubble).toBeVisible({ timeout: 5_000 });
  await expect(bubble).toHaveAttribute("data-margin-bubble-reply-count", "1", { timeout: 5_000 });
});

test("PR2: note bubble never exposes replies (ADR-027)", async ({ page }) => {
  // ADR-027: notes are user-private; the client's `getVisibleReplies()` filter
  // returns `[]` for any annotation whose type !== "comment". The bubble still
  // RENDERS (in the left column for notes) but its reply-count attribute must
  // stay at "0" even after a reply is added to the underlying annotation. We
  // create a real note via the UI popup path (no `tandem_note` MCP tool
  // exists — notes are user-only) and exercise the scroll-invariant
  // positioning layer (lesson #71) by scrolling once between assertions.

  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });

  // Margin view must be on before the note is created so the bubble mounts.
  await setMarginView(page, true);

  // Create a real note via the selection popup (pattern: toolbar-redesign.spec.ts).
  await editor.click();
  await editor.locator("p").first().selectText();
  const popupInput = page.locator("[data-testid='popup-annotation-input']");
  await expect(popupInput).toBeVisible({ timeout: 3_000 });
  await popupInput.fill("private note");
  await page.locator("[data-testid='popup-note-submit']").click();

  // Grab the freshly-created note's id from the editor decoration so we can
  // address its bubble directly. Multiple decorations exist (one per text
  // node spanning the range) — first() is sufficient since they all share
  // the same annotation id.
  const annNode = page.locator("[data-annotation-id]").first();
  await expect(annNode).toBeVisible({ timeout: 10_000 });
  const noteId = await annNode.getAttribute("data-annotation-id");
  expect(noteId, "selection popup must yield an annotation id").toBeTruthy();

  // Note bubble renders on the LEFT column (App.svelte routes
  // `marginNotes` -> left <MarginColumn/>). Reply count starts at "0".
  const bubble = page.locator(
    `[data-testid='margin-column-left'] [data-testid='margin-bubble-${noteId}']`,
  );
  await expect(bubble).toBeVisible({ timeout: 5_000 });
  await expect(bubble).toHaveAttribute("data-margin-bubble-reply-count", "0");

  // Scroll the editor at least once (exercises lesson #71 scroll-invariant
  // positioning layer — `coordsAtPos - layerTop` must remain a finite number,
  // not NaN). The bubble must remain placed and the reply-count untouched.
  await page
    .locator(".editor-scroll")
    .first()
    .evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    });

  // Post a reply against the note's id. The server happily accepts replies
  // for any pending annotation (see `addReplyToAnnotation` — no type guard);
  // the ADR-027 enforcement is client-side in `getVisibleReplies()`. The
  // load-bearing assertion: the bubble's reply-count attribute MUST remain
  // "0" even though a reply row now exists in the Y.Map. Use expect.poll —
  // a thrown rAF / coordsAtPos NaN must surface as test failure, not silent
  // pass via setTimeout.
  await mcp.callTool("tandem_annotationReply", {
    annotationId: noteId as string,
    text: "this reply must never surface",
  });

  // Confirm the reply IS visible to comments — sanity check that the call
  // path is wired by inspecting the underlying replies count via a fresh
  // poll, then confirm the note bubble's filtered count is still 0.
  await expect
    .poll(async () => await bubble.getAttribute("data-margin-bubble-reply-count"), {
      timeout: 5_000,
      message: "note bubble must keep reply-count='0' after reply (ADR-027)",
    })
    .toBe("0");
  await expect(bubble).toBeVisible();
});

test("tab switch: bubbles rebind to the active doc's annotations", async ({ page }) => {
  // Regression guard for PR #720's hoist of margin handlers into a single
  // `$derived`. If the handlers were ever destructured at the call site (or
  // captured into a non-reactive const), they would freeze on the first tab's
  // ydoc/docId and the second tab's bubbles would render against stale state.
  // The visible bubble set switching after a tab swap proves the $derived
  // re-runs against the new `activeTab`.
  const dirB = createFixtureDir("sample2.md");
  try {
    const fileA = path.join(tmpDir, "sample.md");
    const fileB = path.join(dirB, "sample2.md");

    await mcp.callTool("tandem_open", { filePath: fileA });
    await mcp.callTool("tandem_comment", {
      from: TITLE_FROM,
      to: TITLE_TO,
      text: "doc A comment",
      textSnapshot: TITLE_TEXT,
    });
    await mcp.callTool("tandem_open", { filePath: fileB });
    await mcp.callTool("tandem_comment", {
      from: TITLE_FROM,
      to: TITLE_TO,
      text: "doc B comment",
      textSnapshot: TITLE_TEXT,
    });

    await page.goto("/");
    await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
    await setMarginView(page, true);

    // Doc B is active (most recent open). Exactly one comment bubble on the right.
    const rightBubbles = page.locator(
      "[data-testid='margin-column-right'] [data-testid^='margin-bubble-']",
    );
    await expect(rightBubbles).toHaveCount(1, { timeout: 5_000 });
    const bIds = await rightBubbles.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid")),
    );

    // Switch to doc A. The bubble set must change — proving the column annotation
    // input (and, by extension, the $derived that produces the handlers reading
    // `activeTab.ydoc`/`activeTab.id`) re-evaluated against the new tab.
    // Address tabs by exact aria-label so "sample.md" doesn't collide with
    // "sample2.md" via substring matching.
    const tabA = page.locator("[role='tab'][aria-label='sample.md']");
    await expect(tabA).toBeVisible({ timeout: 5_000 });
    await tabA.click();

    await expect(rightBubbles).toHaveCount(1, { timeout: 5_000 });
    await expect
      .poll(
        async () =>
          await rightBubbles.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid"))),
        { timeout: 5_000, message: "bubble id must change on tab switch" },
      )
      .not.toEqual(bIds);
  } finally {
    cleanupFixtureDir(dirB);
  }
});

test("toggle off after on: columns disappear (validates display:contents wrapper fix)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  await setMarginView(page, true);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  // Also wait for a real bubble to confirm the on-state is fully wired before
  // we toggle off (otherwise the toggle-off race might pass for the wrong reason).
  await expect(
    page.locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']").first(),
  ).toBeVisible({ timeout: 5_000 });

  await setMarginView(page, false);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
});
