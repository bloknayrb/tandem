import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

/**
 * #1963 — the active-annotation tint must survive a decoration rebuild.
 *
 * Clicking an annotation tints its span (`.tandem-annotation-active`, the #798
 * A6a "this is the spot" cue, whose keyframe rests at the same 16% accent so
 * the tint PERSISTS while the card is focused). A remote write replaces the PM
 * doc (#1669), ProseMirror re-renders the `[data-annotation-id]` spans, and the
 * tint used to be gone for good afterwards.
 *
 * The fix makes the class part of the annotation DECORATION, so every rebuild
 * reproduces it. `tests/client/decoration-survives-sync.test.ts` pins that at
 * the plugin level with a real bound editor; this spec exists for the half only
 * a browser has — ProseMirror's DOMObserver, which is what defeated the first,
 * imperative fix: it treats a `classList.add` on a span it owns as damage and
 * re-renders the node from the DecorationSet ~1ms later, dispatching no
 * transaction, so no transaction-keyed re-apply can survive it.
 *
 * Shaped on `decoration-survives-mcp-write.spec.ts`, which drives the same
 * y-sync doc replacement from an MCP write.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — the heading prefix costs 2 flat chars, so the title text
// spans 2..15. Same constants as `decoration-survives-mcp-write.spec.ts`.
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

test("#1963: the active-annotation tint survives a decoration rebuild", async ({ page }) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Review this title",
    textSnapshot: TITLE_TEXT,
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });
  const decoration = editor.locator("[data-annotation-id]");
  await expect(decoration).toHaveCount(1, { timeout: 15_000 });

  // Activate it: clicking the decoration runs `onAnnotationClick`, which sets
  // `activeAnnotationId`, which dispatches the plugin's `set-active` meta.
  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await decoration.click();
  await expect(card).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
  await expect(decoration).toHaveClass(/\btandem-annotation-active\b/, { timeout: 10_000 });

  // The rebuild. An edit in an UNRELATED paragraph, below the annotated title,
  // so it cannot overlap the annotated range — an overlapping edit would
  // legitimately move the decoration and this spec would pass for the wrong
  // reason.
  const before = (await mcp.callTool("tandem_getTextContent")) as { data: { text: string } };
  const at = before.data.text.indexOf("Another section with different content");
  expect(at).toBeGreaterThan(-1);
  await mcp.callTool("tandem_edit", {
    from: at,
    to: at,
    newText: "Rebuilt by Claude during the regression test. ",
  });

  await expect(editor).toContainText("Rebuilt by Claude during the regression test.", {
    timeout: 10_000,
  });

  // Still painted (that half is #1669), still the focused annotation, and still
  // tinted.
  await expect(decoration).toHaveCount(1);
  await expect(card).toHaveAttribute("aria-current", "true");

  // A continuous window, not a point read. `toHaveClass` retries until it
  // passes, so it is satisfied by any transient re-application — which is
  // exactly what the imperative fix produced before the DOMObserver repaired
  // the span a millisecond later. Requiring the class on every sample across
  // STEADY_MS is what separates "it came back for a moment" from "it is the
  // resting state", and only the latter is what the user sees.
  const STEADY_MS = 600;
  await expect
    .poll(
      () =>
        page.evaluate(async (steadyMs: number) => {
          const deadline = Date.now() + steadyMs;
          for (;;) {
            // Re-queried every sample, and scoped to `.ProseMirror`: the
            // decoration span is destroyed and re-created by each redraw, so a
            // captured node goes detached and reads false forever, and
            // `data-annotation-id` is also on the side-panel card and the
            // margin-column paths, which never carry the tint.
            const el = document.querySelector(".ProseMirror [data-annotation-id]");
            if (!el?.classList.contains("tandem-annotation-active")) return false;
            if (Date.now() >= deadline) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
        }, STEADY_MS),
      { timeout: 15_000 },
    )
    .toBe(true);
});
