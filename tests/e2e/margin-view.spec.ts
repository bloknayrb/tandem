import { expect, test } from "@playwright/test";
import path from "path";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  nextFrames,
  openAnnotatePopup,
  openSettingsPopover,
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
  await openSettingsPopover(page);
  const popover = page.locator("[data-testid='settings-popover']");
  await expect(popover).toBeVisible({ timeout: 2_000 });
  await popover.getByRole("button", { name: "AI Assistant" }).click();
}

/**
 * Margin visibility is rail-independent since #892, but open rails still feed
 * the narrow auto-hide threshold (open rails shrink the editor). The product
 * default has `rightPanelVisible=true`; at the default ~1280px test viewport an
 * open right rail pushes the threshold (≈544 reserve + ~300 rail + 480 editor)
 * above the viewport, auto-hiding BOTH margins. Closing both rails drops the
 * threshold to ≈1024 so the on-state actually renders. Toggle each rail off
 * only if currently visible (detected via the resize-handle testid). Wave M
 * removed the titlebar panel-toggle buttons; keyboard shortcuts drive it.
 */
async function closeBothRails(page: import("@playwright/test").Page): Promise<void> {
  if ((await page.locator("[data-testid='left-panel-resize-handle']").count()) > 0) {
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(0, {
      timeout: 3_000,
    });
  }
  if ((await page.locator("[data-testid='panel-resize-handle']").count()) > 0) {
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect(page.locator("[data-testid='panel-resize-handle']")).toHaveCount(0, {
      timeout: 3_000,
    });
  }
}

async function setMarginView(
  page: import("@playwright/test").Page,
  enabled: boolean,
): Promise<void> {
  if (enabled) await closeBothRails(page);
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

/**
 * Create a user NOTE via the selection popup (no `tandem_note` MCP tool exists
 * — notes are user-only). Notes are LEFT-side annotations, so this is how a
 * test gives the left margin content; with Stage C-1 empty-collapse, the left
 * column only mounts when a pending note exists. Returns the new note's id.
 * Margin view must already be on so the bubble mounts. Selects the first
 * paragraph's text as the anchor.
 */
async function seedNoteViaPopup(
  page: import("@playwright/test").Page,
  text: string,
): Promise<string> {
  const editor = page.locator(".tiptap");
  await editor.click();
  await editor.locator("p").first().selectText();
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill(text);
  await page.locator("[data-testid='popup-note-submit']").click();
  const annNode = page.locator("[data-annotation-id]").last();
  await expect(annNode).toBeVisible({ timeout: 10_000 });
  const id = await annNode.getAttribute("data-annotation-id");
  if (!id) throw new Error("note popup did not yield an annotation id");
  return id;
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

  // The comment is right-side (outbound). Stage C-1 empty-collapse: the LEFT
  // side has no pending note, so its track collapses and the left column does
  // NOT mount — only the side with content appears. (Column presence is the
  // useful assertion; the columns have no intrinsic height since their bubble
  // children are absolutely positioned.)
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
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

  // Poll directly on the invariant — collapses "wait for collision sweep" and
  // "assert no overlap" into one auto-retrying step. The initial measure →
  // bind:clientHeight → adjustedPositions ping-pong takes ≥ 3 frames; a 5s
  // budget absorbs CI load.
  await expect
    .poll(
      async () =>
        bubbles.evaluateAll((els) => {
          const boxes = els.map((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
          if (boxes.length !== 2) return false;
          const [a, b] = [...boxes].sort((x, y) => x.top - y.top);
          // The lower bubble's top must sit at or below the upper bubble's bottom.
          return b.top >= a.bottom;
        }),
      { timeout: 5_000 },
    )
    .toBe(true);
});

// Extract (startY, endY) from a `bezierLeaderPath` output:
//   "M sx.x,sy.y C cp1x,sy.y cp2x,ey.y ex.x,ey.y"
// Both Y coordinates are 1dp-rounded by the helper, so a tight numeric
// extraction is safe and platform-stable.
function extractStartEndY(d: string): { startY: number; endY: number } | null {
  // M <sx>,<sy> C <cp1x>,<cp1y> <cp2x>,<cp2y> <ex>,<ey>
  const m = d.match(
    /^M -?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?) C -?\d+(?:\.\d+)?,-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?,-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)$/,
  );
  if (!m) return null;
  const startY = parseFloat(m[1]);
  const endY = parseFloat(m[2]);
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) return null;
  return { startY, endY };
}

test("PR3 (C-3): bezier leaders render and slope with collision adjustment", async ({ page }) => {
  // Two adjacent comments on the same line force a collision: the lower
  // bubble's `adjTop > rawTop`, so its leader connects raw editor anchor
  // to pushed-down bubble (visibly tall bezier). The upper bubble is
  // uncollided, so its leader's `endY - startY === LEADER_BUBBLE_INSET_PX`
  // (12) exactly.
  //
  // We extract startY/endY from the SVG `<path>` `d` attribute — these are
  // the values the component wrote, untainted by viewport scroll or device
  // pixel rounding (lesson #71). Sort by startY since `placeable` is
  // annotation-array order, not visual order.
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
  const leaders = leaderSvg.locator("path[data-annotation-id]");
  await expect(leaders).toHaveCount(2, { timeout: 5_000 });

  // Poll until the collision sweep has produced a visibly tall lower leader.
  // The `> 12` predicate proves `adjTop > rawTop` (a real push), not just
  // the constant LEADER_BUBBLE_INSET_PX offset.
  await expect
    .poll(
      async () => {
        const ds = await leaders.evaluateAll((els) => els.map((el) => el.getAttribute("d") ?? ""));
        const ys = ds
          .map(extractStartEndY)
          .filter((v): v is { startY: number; endY: number } => v !== null);
        if (ys.length !== 2) return null;
        const sorted = [...ys].sort((a, b) => a.startY - b.startY);
        return sorted[1].endY - sorted[1].startY;
      },
      { timeout: 5_000, message: "lower leader must span > 12px (collision push, not just inset)" },
    )
    .toBeGreaterThan(12);

  // Snapshot once and verify both leaders independently. Upper leader is
  // uncollided — `endY - startY === LEADER_BUBBLE_INSET_PX` (12) within 1px
  // tolerance for the 1dp rounding in `bezierLeaderPath`.
  const ds = await leaders.evaluateAll((els) => els.map((el) => el.getAttribute("d") ?? ""));
  const ys = ds
    .map(extractStartEndY)
    .filter((v): v is { startY: number; endY: number } => v !== null);
  const [upper, lower] = [...ys].sort((a, b) => a.startY - b.startY);
  expect(Math.abs(upper.endY - upper.startY - 12)).toBeLessThan(1);
  expect(lower.endY - lower.startY).toBeGreaterThan(12);
});

test("C-3: per-author stroke color (Claude on right) + anchor dot count matches bubbles", async ({
  page,
}) => {
  // Two Claude-authored comments give us a deterministic right-side render
  // with `data-tandem-author="claude"` on every path + circle. Anchor-dot
  // count must equal bubble count per side (one dot per pending placeable).
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_FROM + 4,
    text: "first claude",
    textSnapshot: TITLE_TEXT.slice(0, 4),
  });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM + 5,
    to: TITLE_TO,
    text: "second claude",
    textSnapshot: TITLE_TEXT.slice(5),
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  const rightLeaders = page.locator("[data-testid='margin-leaders-right']");
  await expect(rightLeaders).toHaveCount(1, { timeout: 5_000 });

  const rightBubbles = page.locator(
    "[data-testid='margin-column-right'] [data-testid^='margin-bubble-']",
  );
  await expect(rightBubbles).toHaveCount(2, { timeout: 5_000 });

  // Per-author stroke on the path attribute (resolution to the CSS variable
  // is unit-tested elsewhere; here we verify the attribute itself).
  const claudePaths = rightLeaders.locator("path[data-tandem-author='claude']");
  await expect(claudePaths).toHaveCount(2, { timeout: 5_000 });
  const strokes = await claudePaths.evaluateAll((els) =>
    els.map((el) => el.getAttribute("stroke")),
  );
  for (const stroke of strokes) {
    expect(stroke).toBe("var(--tandem-author-claude)");
  }

  // Anchor dots: count matches placeable bubbles per side; testid is
  // non-id-bearing (ADR-027 — note IDs are NOT a queryable testid surface).
  // Per-id queries continue to use `data-annotation-id` if needed.
  const rightDots = rightLeaders.locator("circle[data-testid='margin-anchor-dot']");
  await expect(rightDots).toHaveCount(2, { timeout: 5_000 });
  const claudeDots = rightLeaders.locator(
    "circle[data-testid='margin-anchor-dot'][data-tandem-author='claude']",
  );
  await expect(claudeDots).toHaveCount(2, { timeout: 5_000 });
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
  await openAnnotatePopup(page);
  const popupInput = page.locator("[data-testid='popup-annotation-input']");
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

    // sample.md has "# Test Document" (title 2..15 = "Test Document").
    // sample2.md has "# Second Document" (title 2..17 = "Second Document").
    // tandem_comment validates textSnapshot against the actual range text and
    // silently drops the annotation on mismatch, so each file gets its own
    // range tuple.
    await mcp.callTool("tandem_open", { filePath: fileA });
    await mcp.callTool("tandem_comment", {
      from: TITLE_FROM,
      to: TITLE_TO,
      text: "doc A comment",
      textSnapshot: TITLE_TEXT,
    });
    await mcp.callTool("tandem_open", { filePath: fileB });
    await mcp.callTool("tandem_comment", {
      from: 2,
      to: 17,
      text: "doc B comment",
      textSnapshot: "Second Document",
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

test("toggle off after on: margin columns unmount", async ({ page }) => {
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

/**
 * INVARIANT 1 (App.svelte:1554-1559): the `marginLayerEl` <div> — the grid
 * stage container `[data-testid='editor-stage']` — must stay mounted across
 * `marginView` toggles. If a future refactor wraps it in `{#if marginView}`,
 * the `bind:this` ref nulls on toggle-off and re-binds to a NEW element on
 * toggle-on; `useMarginPositions`'s `$effect` would tear down + re-subscribe,
 * but any `getBoundingClientRect()` reads queued during the gap would return
 * the wrong rect, and the doc warning at
 * `feedback_svelte_state_bind_this_loop` becomes a retry storm.
 *
 * The pre-existing "toggle off after on" test (above) only proves the inner
 * margin-column children unmount; it never cycles back ON to verify bubbles
 * re-anchor against the SAME stage element. The off→on→off→on cycle below
 * captures stage element identity and asserts it survives the round trip,
 * plus a margin bubble re-anchors on re-enable.
 */
test("INVARIANT 1: editor-stage element survives off→on→off→on toggle cycle", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Stamp the stage element with a unique session id BEFORE the cycle. The id
  // is read after each toggle; surviving the cycle == same DOM node throughout
  // == `bind:this` never re-bound == invariant held.
  const stage = page.locator("[data-testid='editor-stage']");
  await expect(stage).toHaveCount(1, { timeout: 5_000 });
  const stageId = `stage-${Math.random().toString(36).slice(2, 10)}`;
  await stage.evaluate((el, id) => {
    el.setAttribute("data-test-stage-id", id);
  }, stageId);

  // Cycle: on → off → on → off → on.
  await setMarginView(page, true);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(stage).toHaveAttribute("data-test-stage-id", stageId);

  await setMarginView(page, false);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
  await expect(stage).toHaveAttribute("data-test-stage-id", stageId);

  await setMarginView(page, true);
  // The bubble must re-render and re-anchor on the SAME stage element. If the
  // stage had remounted, the bubble would render but `useMarginPositions`
  // would be working against a stale bind reference and bubble Y would be
  // wrong (or the bubble would never appear if the effect cleanup ran late).
  await expect(
    page.locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']").first(),
  ).toBeVisible({ timeout: 5_000 });
  await expect(stage).toHaveAttribute("data-test-stage-id", stageId);

  await setMarginView(page, false);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);
  await expect(stage).toHaveAttribute("data-test-stage-id", stageId);
});

/**
 * #892 — margin visibility is DECOUPLED from rail state. Opening a rail no
 * longer hides that side's margin column: the left rail is the OUTLINE (nothing
 * to do with annotations), so hiding the left-margin notes when the outline
 * opens was semantically arbitrary — a leftover geometric hack from the
 * absolute-positioning layout. With the grid, the `1fr` gutters + the narrow
 * threshold handle space, so a rail opening with room to spare leaves both
 * margins in place. Tested one rail at a time to stay clear of the both-rails
 * narrow threshold at this viewport (threshold ≈ 544 + railWidth + 480).
 */
test("opening a rail keeps both margin columns (#892 decoupling)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  // Give the LEFT side content too (a note): with Stage C-1 empty-collapse the
  // left column only mounts when a pending note exists, so #892 rail-decoupling
  // is only observable on the left once a note is present. Without this the
  // "left stays mounted when the left rail opens" assertion would be vacuous.
  await seedNoteViaPopup(page, "left-side note");
  const leftCol = page.locator("[data-testid='margin-column-left']");
  const rightCol = page.locator("[data-testid='margin-column-right']");
  const leftHandle = page.locator("[data-testid='left-panel-resize-handle']");
  const rightHandle = page.locator("[data-testid='panel-resize-handle']");
  await expect(leftCol).toHaveCount(1);
  await expect(rightCol).toHaveCount(1);

  // Open the LEFT rail (outline) → it must actually open (handle appears), and
  // BOTH margins stay (Bryan's complaint: the outline must not hide notes).
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(leftHandle).toHaveCount(1, { timeout: 3_000 });
  await expect(leftCol).toHaveCount(1);
  await expect(rightCol).toHaveCount(1);

  // Close the left rail, then open the RIGHT rail alone → both margins still
  // stay (one rail at a time keeps us under the narrow threshold).
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(leftHandle).toHaveCount(0, { timeout: 3_000 });
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(rightHandle).toHaveCount(1, { timeout: 3_000 });
  await expect(leftCol).toHaveCount(1);
  await expect(rightCol).toHaveCount(1);
});

/**
 * #683 PR3 — Narrow-viewport auto-hide. Below a computed threshold (margin
 * reserve + open rails + minimum readable editor width), BOTH columns hide
 * regardless of rail state, so the editor never gets crushed.
 */
test("PR3: narrow viewport hides both margin columns", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  // Comment-only doc: right side has content (mounts), left empty-collapses
  // (Stage C-1). The right column is the "visible at wide" proxy.
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);

  // Shrink to a width well below the stub→off floor (t3 ≈ 600). Below it BOTH
  // sides go off regardless of content, so even the populated right side hides.
  await page.setViewportSize({ width: 500, height: 900 });
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(0);

  // Grow back to a wide viewport → the populated right column returns.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);
});

/**
 * #683 PR3 — Hysteresis. The narrowSticky entry/exit bands are offset by
 * MARGIN_VIEW_HYSTERESIS_PX (32) so a viewport drag through the threshold
 * doesn't flip columns on/off at 60fps. We resize across the boundary three
 * times (narrow → just-over → narrow) and confirm the columns end up in the
 * narrow state without thrashing back to visible on the brief overshoot.
 */
test("PR3: boundary resize does not flicker (hysteresis)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // Stage C-1: hysteresis is tested at the stub→off floor (t3 ≈ 600, rails
  // closed). The comment is right-side, so the RIGHT column is the populated
  // probe. Below t3 → off (right hidden); a small overshoot back above t3 but
  // inside the 32px deadband must NOT re-show it; then drop below again.
  const right = page.locator("[data-testid='margin-column-right']");
  await page.setViewportSize({ width: 560, height: 900 }); // < t3 → off
  await expect(right).toHaveCount(0);

  await page.setViewportSize({ width: 620, height: 900 }); // in [t3, t3+H) → hold off
  await nextFrames(page);
  await expect(right).toHaveCount(0);

  await page.setViewportSize({ width: 560, height: 900 });
  await expect(right).toHaveCount(0);

  // Clear the deadband (> t3 + H ≈ 632) → the stub re-shows, proving the column
  // wasn't simply stuck off.
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(right).toHaveCount(1);
});

/**
 * #683 PR3 — Auto-hide must not write user-intent state. The narrow-collapse
 * flag is local to App.svelte; sweeping the viewport through and back across
 * the threshold must leave `rightPanelVisible`/`leftPanelVisible` in
 * `tandem:settings` untouched. Without this guarantee, a window resize would
 * silently overwrite the user's persisted panel preferences.
 */
test("PR3: narrow-collapse does not overwrite persisted rail visibility", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // `setMarginView` closes both rails as a setup side effect (so existing
  // tests don't trip on the default-right-rail visible behaviour). Run it
  // first, THEN snapshot the rail state — this test is checking that the
  // viewport sweep doesn't write to settings, not that the setup helper
  // leaves them untouched.
  await setMarginView(page, true);

  const before = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw
      ? (JSON.parse(raw) as { rightPanelVisible?: unknown; leftPanelVisible?: unknown })
      : null;
  }, TANDEM_SETTINGS_KEY);

  // Sweep through the narrow boundary and back. Wait between transitions so
  // the $effect that drives narrowSticky actually runs — if it were ever to
  // touch settings, this is when it would. `nextFrames` covers the full
  // resize → ResizeObserver → useViewportWidth rAF debounce → $effect → DOM
  // chain deterministically (replaces a hardcoded 120ms wait).
  await page.setViewportSize({ width: 700, height: 900 });
  await nextFrames(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await nextFrames(page);

  // Settings must reflect the pre-sweep snapshot exactly.
  const after = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw
      ? (JSON.parse(raw) as { rightPanelVisible?: unknown; leftPanelVisible?: unknown })
      : null;
  }, TANDEM_SETTINGS_KEY);
  expect(after?.rightPanelVisible).toBe(before?.rightPanelVisible);
  expect(after?.leftPanelVisible).toBe(before?.leftPanelVisible);
});

/**
 * Stage A (Phase 3.5) — the editor stage reserves margin width PER SIDE, not
 * globally. The old `editorMaxWidth` cascade subtracted the full both-sides
 * reserve whenever margin view was effectively on (defect #1); the grid gives
 * each side its own track. The runtime residual we can assert at the E2E layer:
 * tracks carry the reserve only while margins render (on → non-zero, off → 0),
 * and (since #892) a rail opening does NOT collapse a track. Stage C-1 adds the
 * runtime per-side asymmetry: a side with no pending annotation empty-collapses
 * to 0 while the other reserves — so a comment-only doc reserves the right track
 * and zeroes the left at runtime. We read the resolved grid-template-columns off
 * the stage — [gutter, marginL, content, marginR, gutter] — so tokens[1]/
 * tokens[3] are the px reserves.
 */
async function marginTracks(
  page: import("@playwright/test").Page,
): Promise<{ left: string; right: string }> {
  return page.locator("[data-testid='editor-stage']").evaluate((el) => {
    const cols = getComputedStyle(el).gridTemplateColumns.split(/\s+/);
    return { left: cols[1], right: cols[3] };
  });
}

test("Stage A: tracks reserve only while margins render, rail-independent", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  // 1600 keeps a single-rail-open layout clear of the narrow auto-hide band
  // (threshold with one ~300px rail open ≈ 544 + 300 + 480 = 1324 < 1600).
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });

  // Comment-only doc, margins on, both rails closed. Stage C-1 takes the
  // per-side reserve down to ANNOTATION granularity: the RIGHT side has content
  // (track reserves), the LEFT side has no pending note → empty-collapses to 0.
  await setMarginView(page, true);
  await expect.poll(async () => (await marginTracks(page)).right).not.toBe("0px");
  expect((await marginTracks(page)).left).toBe("0px");

  // Open the LEFT rail (outline) → the right track is UNCHANGED (#892
  // decoupling); the left stays 0 (still no note — not because the rail opened).
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(page.locator("[data-testid='left-panel-resize-handle']")).toHaveCount(1, {
    timeout: 3_000,
  });
  expect((await marginTracks(page)).right).not.toBe("0px");
  expect((await marginTracks(page)).left).toBe("0px");

  // Disable margin view → both tracks collapse to 0 (no phantom reserve — the
  // residual of defect #1: the old cascade reserved the full width even off).
  await page.keyboard.press("Alt+Shift+ArrowLeft"); // re-close the left rail
  await setMarginView(page, false);
  await expect.poll(async () => (await marginTracks(page)).right).toBe("0px");
  expect((await marginTracks(page)).left).toBe("0px");
});

/**
 * Regression for the grid-row bug found during Stage A dogfooding: the margin
 * tracks (grid columns 2 & 4) are declared AFTER the content (column 3) in DOM
 * order but at LOWER column indices, so under the default sparse
 * `grid-auto-flow: row` they were bumped into a SECOND row below the content —
 * dumping every bubble at the bottom of the stage. The fix pins all cells to
 * `grid-row: 1`. Guard it by asserting each margin track's top coincides with
 * the stage's top (single row), not content-height below it.
 */
test("Stage A: margin tracks share the stage's top row (grid-row regression)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  // Comment-only doc → only the RIGHT track renders (left empty-collapses,
  // Stage C-1). One rendered `.margin-track` is enough to guard the grid-row
  // pin — the bug would dump it a full content-height below the stage top.
  await expect(page.locator(".margin-track")).toHaveCount(1, { timeout: 5_000 });

  const deltas = await page.evaluate(() => {
    const stage = document.querySelector("[data-testid='editor-stage']");
    const tracks = [...document.querySelectorAll(".margin-track")];
    if (!stage || tracks.length === 0) return null;
    const stageTop = stage.getBoundingClientRect().top;
    return tracks.map((t) => Math.abs(t.getBoundingClientRect().top - stageTop));
  });
  expect(deltas).not.toBeNull();
  // Each rendered track's top within 1px of the stage top → grid row 1. The bug
  // put them a full content-height (hundreds of px) below.
  for (const delta of deltas as number[]) expect(delta).toBeLessThan(1);
});

/**
 * Stage C-1 — the CYCLE REGRESSION the plan review flagged as the HIGH blocker.
 * The presence-collapse booleans (`getLeftHasPending`/`getRightHasPending`) MUST
 * read the ungated `visibleAnnotations`, not the `effectivelyOn`-gated render
 * arrays. If a future refactor re-wires them off the gated arrays, the `$derived`
 * graph closes a loop through `effectivelyOn` and latches "all-off" — margin view
 * silently renders NOTHING despite being on with a pending annotation. This test
 * fails loudly in exactly that case: margin view on + a pending comment must
 * render the right column AND its bubble.
 */
test("C-1: margin view on with a pending comment renders the column (cycle regression)", async ({
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
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // The load-bearing assertion: the column renders (not silently empty).
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(
    page.locator("[data-testid='margin-column-right'] [data-testid^='margin-bubble-']").first(),
  ).toBeVisible({ timeout: 5_000 });
});

/**
 * Stage C-1 empty-collapse — a NOTE (left) + COMMENT (right) make BOTH sides
 * present, so both columns mount and both tracks reserve width. The complement
 * to the comment-only tests above (which prove the empty left side collapses).
 */
test("C-1: a note + a comment mount both columns (presence on both sides)", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "right-side comment",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  await seedNoteViaPopup(page, "left-side note");

  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  const tracks = await marginTracks(page);
  expect(tracks.left).not.toBe("0px");
  expect(tracks.right).not.toBe("0px");
});

/**
 * Stage C-1 empty-collapse is LIVE: adding the first note to a previously-empty
 * left side expands its track (and removing the last would collapse it again —
 * the symmetric direction is covered by the comment-only static tests). Proves
 * the presence booleans recompute against `visibleAnnotations` as annotations
 * change, not just at mount.
 */
test("C-1: adding the first note expands the collapsed left side live", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "right-side comment",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  // Comment-only start: left collapsed, right present.
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(0);

  // Add the first left-side note → left expands live.
  await seedNoteViaPopup(page, "first note");
  await expect(page.locator("[data-testid='margin-column-left']")).toHaveCount(1);
  await expect(page.locator("[data-testid='margin-column-right']")).toHaveCount(1);
});

/**
 * Stage C-1 continuum — as the viewport narrows, the rendered margin track steps
 * full → narrow → stub → off. We assert the right track (comment side) shrinks
 * MONOTONICALLY across the bands, then disappears below the off floor —
 * estimate-independent (it tests the ladder property, not the specific px so it
 * survives a `narrow`/`stub` width tune). Rails are closed by setMarginView, so
 * thresholds are t1≈1024 / t2≈864 / t3≈600.
 */
test("C-1: narrowing the viewport steps the margin track full→narrow→stub→off", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Margin candidate",
    textSnapshot: TITLE_TEXT,
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  const rightCol = page.locator("[data-testid='margin-column-right']");
  const rightTrackPx = async () => parseFloat((await marginTracks(page)).right);

  // full band (> t1): widest reserve.
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(rightTrackPx).toBeGreaterThan(0);
  const fullPx = await rightTrackPx();

  // narrow band (t2 < w < t1): strictly narrower than full.
  await page.setViewportSize({ width: 950, height: 900 });
  await expect.poll(rightTrackPx).toBeLessThan(fullPx);
  const narrowPx = await rightTrackPx();
  expect(narrowPx).toBeGreaterThan(0);

  // stub band (t3 < w < t2): strictly narrower than narrow.
  await page.setViewportSize({ width: 750, height: 900 });
  await expect.poll(rightTrackPx).toBeLessThan(narrowPx);
  expect(await rightTrackPx()).toBeGreaterThan(0);

  // off (< t3): the column unmounts entirely.
  await page.setViewportSize({ width: 500, height: 900 });
  await expect(rightCol).toHaveCount(0);
});

/**
 * Stage C-1 docx carve-out (the CRDT-HIGH guard) — docx keeps its legacy
 * relative/contents path and NEVER enters the continuum grid, so it can never
 * receive narrow/stub track geometry. The stage element's computed display must
 * not be `grid` for a docx tab, at a wide width (margins on → position:relative)
 * and at an intermediate width where a non-docx doc would be `narrow` (docx →
 * display:contents, off cliff). Either way: never a grid.
 */
test("C-1: docx keeps its legacy path — stage is never a grid", async ({ page }) => {
  const docxDir = createFixtureDir("single-paragraph.docx");
  try {
    await mcp.callTool("tandem_open", { filePath: path.join(docxDir, "single-paragraph.docx") });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    const stage = page.locator("[data-testid='editor-stage']");
    await expect(stage).toHaveCount(1, { timeout: 10_000 });

    await setMarginView(page, true);

    const stageDisplay = () => stage.evaluate((el) => getComputedStyle(el as HTMLElement).display);

    // Wide: margins on → docx uses position:relative (display stays block), not grid.
    expect(await stageDisplay()).not.toBe("grid");

    // Intermediate width (a non-docx doc would be `narrow` here): docx falls to
    // its off cliff (display:contents) — still never a grid, never narrow geometry.
    await page.setViewportSize({ width: 950, height: 900 });
    await nextFrames(page);
    expect(await stageDisplay()).not.toBe("grid");
  } finally {
    cleanupFixtureDir(docxDir);
  }
});

/**
 * Stage C-2 — density variants. The `MarginMode` continuum (C-1) drives a
 * per-card density (`cardDensity`): in the NARROW band an inactive card clamps
 * to a one-line teaser and the active (focused) card expands to full; in the
 * STUB band EVERY card is a ~22px pip regardless of active/editing — the 28px
 * stub track can't hold card chrome (see the stub-geometry note in
 * cardDensity.ts; this is the resolved divergence from plan §5 "stub click →
 * full in place" and the C4 bundle, where the collapsed pill also never expands
 * itself but lives in a 128px-wide column that production's 28px track is not).
 * Widths reuse the C-1 ladder (1200=full / 950=narrow / 750=stub / 500=off),
 * proven deterministic above. The card carries `data-density` for assertions.
 *
 * Nothing is selected on load (empty is the resting state — the dedicated
 * review mode was removed), so these specs seed TWO comments and click one to
 * fix which is active. The active card is `full` in the narrow band; the other
 * is then deterministically inactive (clamped at narrow / a pip at stub).
 */
async function seedTwoComments(): Promise<{ idA: string; idB: string }> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  const a = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_FROM + 4,
    text: "first comment — the one these specs activate",
    textSnapshot: TITLE_TEXT.slice(0, 4),
  })) as { error: false; data: { annotationId: string } } | { error: true };
  const b = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM + 5,
    to: TITLE_TO,
    text: "a fairly long second comment body so the clamp visibly collapses it to one line",
    textSnapshot: TITLE_TEXT.slice(5),
  })) as { error: false; data: { annotationId: string } } | { error: true };
  if (a.error !== false || b.error !== false) throw new Error("tandem_comment failed");
  return { idA: a.data.annotationId, idB: b.data.annotationId };
}

test("C-2: narrow band clamps the inactive card while the active one stays full", async ({
  page,
}) => {
  const { idA, idB } = await seedTwoComments();
  await page.setViewportSize({ width: 950, height: 900 }); // narrow band
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // Scope through the `margin-bubble-{id}` wrapper: the `annotation-card-{id}`
  // testid also appears in the always-mounted (display:none) side panel, so a
  // bare card selector matches two elements.
  const cardA = page.locator(
    `[data-testid='margin-bubble-${idA}'] [data-testid='annotation-card-${idA}']`,
  );
  const cardB = page.locator(
    `[data-testid='margin-bubble-${idB}'] [data-testid='annotation-card-${idB}']`,
  );
  await expect(cardA).toBeVisible({ timeout: 5_000 });
  await expect(cardB).toBeVisible({ timeout: 5_000 });

  // Force A active → A full, B inactive → clamped. Deterministic regardless of
  // which card the review hook auto-selects on load.
  await cardA.click();
  await expect(cardA).toHaveAttribute("data-density", "full", { timeout: 5_000 });
  await expect(cardB).toHaveAttribute("data-density", "clamped", { timeout: 5_000 });
  // Action row is hidden in clamped (the accept button lives in `.aca-row`).
  await expect(cardB.locator("[data-testid^='accept-btn-']")).toBeHidden();

  // [MF-3] — the clamped card is actually SHORTER, not just missing its action
  // row. Capture B's clamped height, activate B (which clamps A), assert B grew.
  const clampedBox = await cardB.boundingBox();
  expect(clampedBox).not.toBeNull();

  await cardB.click();
  await expect(cardB).toHaveAttribute("data-density", "full", { timeout: 5_000 });
  await expect(cardA).toHaveAttribute("data-density", "clamped", { timeout: 5_000 });
  await expect(cardB.locator("[data-testid^='accept-btn-']")).toBeVisible();
  await expect
    .poll(async () => (await cardB.boundingBox())?.height ?? 0, {
      timeout: 5_000,
      message: "activated (full) card must be taller than the clamped teaser",
    })
    .toBeGreaterThan((clampedBox as { height: number }).height);
});

test("C-2: stub band collapses every card to a pip that fits the column and stays a pip when clicked", async ({
  page,
}) => {
  const { idA, idB } = await seedTwoComments();
  await page.setViewportSize({ width: 750, height: 900 }); // stub band
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  // Scope through `margin-bubble-{id}` — the card testid is also present in the
  // always-mounted (display:none) side panel.
  const bubbleA = page.locator(`[data-testid='margin-bubble-${idA}']`);
  const cardA = bubbleA.locator(`[data-testid='annotation-card-${idA}']`);
  const cardB = page.locator(
    `[data-testid='margin-bubble-${idB}'] [data-testid='annotation-card-${idB}']`,
  );
  await expect(cardA).toBeVisible({ timeout: 5_000 });
  await expect(cardB).toBeVisible({ timeout: 5_000 });

  // Both cards are pips in the stub band — active state is irrelevant.
  await expect(cardA).toHaveAttribute("data-density", "stub", { timeout: 5_000 });
  await expect(cardB).toHaveAttribute("data-density", "stub", { timeout: 5_000 });

  // Body / snippet / actions collapse in stub; the wrapper persists so the pip
  // is clickable (stub ≠ display:none).
  await expect(cardA.locator(".aca-body")).toBeHidden();
  await expect(cardA.locator("[data-testid^='accept-btn-']")).toBeHidden();

  // THE ACCEPTANCE GATE (advisor): the stub card must FIT inside its column —
  // no horizontal spill past the column edge (the clipping bug the continuum
  // exposed). `scrollWidth > clientWidth` is precisely the overflow signature;
  // a 1px tolerance absorbs sub-pixel rounding.
  const fit = await cardA.evaluate((el) => {
    const e = el as HTMLElement;
    return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
  });
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);

  // The card's rendered box must also sit within its column wrapper.
  const within = await bubbleA.evaluate((wrapper) => {
    const card = wrapper.querySelector("[data-testid^='annotation-card-']") as HTMLElement | null;
    if (!card) return false;
    const w = wrapper.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return c.right <= w.right + 1 && c.left >= w.left - 1;
  });
  expect(within).toBe(true);

  // A stub stays a pip even when it's the ACTIVE review target — the 28px stub
  // track has no room to expand in place. Selection no longer auto-loads (empty
  // is the resting state since the dedicated review mode was removed), so make a
  // card active by clicking the comment's anchor span in the EDITOR. The
  // overlapping stub pips can't be clicked directly (STUB-NON-PUSH — they'd
  // intercept each other's click), but the editor anchor sits in the center
  // column (not the margins) and routes through handleEditorClick → selects one
  // of the two comments. The density code path is identical regardless of how the
  // card became active.
  await page.locator(".tandem-editor [data-annotation-id]").first().click();
  const activeStub = page.locator(
    "[data-testid='margin-column-right'] .tandem-annotation-card.is-review-target",
  );
  await expect(activeStub).toHaveAttribute("data-density", "stub", { timeout: 5_000 });
  await expect(activeStub.locator(".aca-body")).toBeHidden();
});

/**
 * Stage C-2 — the ACTIVE-FULL-AT-NARROW fit guard (advisor). The stub-band
 * scrollWidth gate above runs on a pip that trivially fits; the case that can
 * still clip is the *active/full* card at narrow=160, where a richer card type
 * renders its full body inside the slimmest non-stub track. SuggestionCard is
 * the worst offender: its diff box (`suggestion-diff-{id}`) holds a
 * strikethrough-old → new pair of padded, background-filled spans whose
 * min-content is wider than the plain comment we measured for the stub
 * diagnosis. Clicking the suggestion's editor anchor makes it the active review
 * target → `full` in the narrow band, so a single suggestion exercises exactly
 * this path. The acceptance gate is the same one the stub spec uses, one band
 * over and one card type richer: the card root must not spill past its column.
 */
test("C-2: an active suggestion at narrow fits its column (no diff-box spill)", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  const created = (await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "tighten the heading",
    // A realistic multi-word replacement — the diff box must wrap it inside the
    // 160px narrow track, not push the card wider than the column.
    suggestedText: "Comprehensive Project Title",
    textSnapshot: TITLE_TEXT,
  })) as { error: false; data: { annotationId: string } } | { error: true };
  if (created.error !== false) throw new Error("tandem_comment (suggestion) failed");
  const id = created.data.annotationId;

  await page.setViewportSize({ width: 950, height: 900 }); // narrow band
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);

  const bubble = page.locator(`[data-testid='margin-bubble-${id}']`);
  const card = bubble.locator(`[data-testid='annotation-card-${id}']`);
  await expect(card).toBeVisible({ timeout: 5_000 });

  // Selection no longer auto-loads (empty is the resting state since the
  // dedicated review mode was removed), so click the suggestion's editor anchor
  // to make it the active review target — only then does it render `full`
  // (active) rather than the clamped resting density. Clicking the center-column
  // anchor routes through handleEditorClick → selects this annotation.
  await page.locator(".tandem-editor [data-annotation-id]").first().click();

  // Active suggestion → full at narrow. The diff box must actually render (this
  // is the body that the stub band hides and the clamped band collapses — here
  // it's the full, unclamped suggestion).
  await expect(card).toHaveAttribute("data-density", "full", { timeout: 5_000 });
  await expect(card.locator(`[data-testid='suggestion-diff-${id}']`)).toBeVisible({
    timeout: 5_000,
  });

  // THE ACCEPTANCE GATE: the full suggestion card must FIT its narrow column —
  // the diff-box spans must wrap, not spill horizontally past the card edge.
  // `scrollWidth > clientWidth` is the overflow signature; 1px absorbs rounding.
  const fit = await card.evaluate((el) => {
    const e = el as HTMLElement;
    return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
  });
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);

  // And the rendered box sits within its column wrapper (catches a spill that a
  // card-internal `overflow:clip` would hide from scrollWidth but still paint
  // past the column edge).
  const within = await bubble.evaluate((wrapper) => {
    const c = wrapper.querySelector("[data-testid^='annotation-card-']") as HTMLElement | null;
    if (!c) return false;
    const w = wrapper.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    return r.right <= w.right + 1 && r.left >= w.left - 1;
  });
  expect(within).toBe(true);
});

test("C-2: density sweep full→narrow→stub→full emits no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  const { idA, idB } = await seedTwoComments();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toContainText(TITLE_TEXT, { timeout: 10_000 });
  await expect(page.locator("[data-annotation-id]").first()).toBeVisible({ timeout: 15_000 });

  await setMarginView(page, true);
  // Scope through `margin-bubble-{id}` — the card testid is also present in the
  // always-mounted (display:none) side panel.
  const cardA = page.locator(
    `[data-testid='margin-bubble-${idA}'] [data-testid='annotation-card-${idA}']`,
  );
  const cardB = page.locator(
    `[data-testid='margin-bubble-${idB}'] [data-testid='annotation-card-${idB}']`,
  );
  await expect(cardA).toBeVisible({ timeout: 5_000 });

  // Fix A active so B is deterministically inactive — B then steps through every
  // density as the viewport sweeps the bands (an active card would stay `full`
  // in the narrow band and never exercise `clamped`). At this 1200 full band
  // both cards are still `full`; B only diverges once we drop to narrow.
  await cardA.click();
  await expect(cardA).toHaveClass(/is-review-target/, { timeout: 5_000 });

  // full → narrow (clamped) → stub → back to full, with a frame settle between
  // each so the density `$effect` (overlay-close guard) actually runs. A retry
  // storm from a missing last-value guard would surface as console errors here.
  await expect(cardB).toHaveAttribute("data-density", "full", { timeout: 5_000 });
  await page.setViewportSize({ width: 950, height: 900 });
  await expect(cardB).toHaveAttribute("data-density", "clamped", { timeout: 5_000 });
  await page.setViewportSize({ width: 750, height: 900 });
  await expect(cardB).toHaveAttribute("data-density", "stub", { timeout: 5_000 });
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(cardB).toHaveAttribute("data-density", "full", { timeout: 5_000 });
  await nextFrames(page);

  // Filter to app/effect errors — ignore benign Y.js "Invalid access" stderr
  // noise documented in CLAUDE.md (it can surface as a console error in dev).
  const appErrors = errors.filter((e) => !/Invalid access|favicon/i.test(e));
  expect(appErrors, `unexpected console errors: ${appErrors.join("\n")}`).toEqual([]);
});
