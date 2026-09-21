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
 * #1963 — the active-annotation pulse must survive a decoration rebuild.
 *
 * `Editor.svelte`'s pulse effect writes `.tandem-annotation-active` onto DOM
 * nodes the annotation decoration plugin produced, but it read only `editor`
 * and `activeAnnotationId`. When y-prosemirror's `_typeChanged` replaces the PM
 * doc on a remote write (#1669) and ProseMirror re-renders the
 * `[data-annotation-id]` spans, neither input moves, the effect does not re-run
 * and the pulse is silently gone from a still-active annotation.
 *
 * This is not optional coverage: an implementation that ships
 * `deco-revision.ts` and wires the counter but omits the one-line
 * `void decoRevision;` read is green on every unit spec with #1963 unfixed, and
 * nothing under `tests/` renders `Editor.svelte`.
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

test("#1963: the active-annotation pulse survives a decoration rebuild", async ({ page }) => {
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
  // `activeAnnotationId` — the input the pulse effect keys on. The side-panel
  // card's `aria-current` is the oracle for "this annotation is focused", NOT
  // the editor's own `.tandem-annotation-active`: that class is written onto
  // ProseMirror-owned decoration spans and is wiped whenever ProseMirror
  // redraws them (`highlight-ux.spec.ts` says so outright), which is exactly
  // the defect under test — so asserting it here would be asserting the bug
  // does not happen before the rebuild this spec drives.
  const card = page.locator("[data-testid^='annotation-card-']").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await decoration.click();
  await expect(card).toHaveAttribute("aria-current", "true", { timeout: 10_000 });

  // Watch for RE-APPLICATIONS of the pulse class. This counter is the *weak*
  // half of the oracle and is kept only because it discriminates sharply
  // against master: it is exactly 0 there — the pulse effect reads only
  // `editor` and `activeAnnotationId`, neither of which moves on a remote
  // write, so nothing ever re-applies — and ≥1 once the counter is wired.
  //
  // It is not sufficient on its own, and the first cut of this spec stopped
  // here. ProseMirror rewrites the decoration span's `class` attribute on every
  // redraw, and the redraws that follow a remote write (`yjs-cursor$`,
  // `tandemAuthorship$`, `tandemAwareness$` — all decoration-bearing plugins,
  // none of them a decoration REBUILD) land a few milliseconds after the y-sync
  // transaction and strip it again. A gate that covers only the y-sync
  // transaction therefore re-applies the class once and loses it again
  // milliseconds later: this counter goes to ≥1 and the user still sees no
  // highlight. The steady-state assertion at the end of this spec is the one
  // that catches that, so do not drop it back to the count alone.
  await page.evaluate(() => {
    (window as unknown as { __pulseAdds: number }).__pulseAdds = 0;
    const root = document.querySelector(".ProseMirror");
    if (!root) throw new Error("no ProseMirror root");
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el.classList?.contains("tandem-annotation-active")) {
          (window as unknown as { __pulseAdds: number }).__pulseAdds++;
        }
      }
    }).observe(root, { attributes: true, subtree: true, attributeFilter: ["class"] });
  });

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

  // Still painted (that half is #1669), still the active annotation, and the
  // pulse was re-applied to it after the rebuild.
  await expect(decoration).toHaveCount(1);
  await expect(card).toHaveAttribute("aria-current", "true");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __pulseAdds: number }).__pulseAdds), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  // …and it STAYS applied. The sample is a continuous window, not a point
  // read: a plain `toHaveClass` retries until it passes, so it is satisfied by
  // the single transient re-application a y-sync-only gate produces and would
  // be green on the defect this assertion exists to catch. Each probe requires
  // the class to be present on every sample across STEADY_MS, so the trailing
  // `yjs-cursor$` / `tandemAwareness$` / `tandemAuthorship$` redraws must each
  // be followed by a re-application for it to hold.
  const STEADY_MS = 600;
  await expect
    .poll(
      () =>
        page.evaluate(async (steadyMs: number) => {
          const el = document.querySelector("[data-annotation-id]");
          const deadline = Date.now() + steadyMs;
          for (;;) {
            if (!el?.classList.contains("tandem-annotation-active")) return false;
            if (Date.now() >= deadline) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
        }, STEADY_MS),
      { timeout: 15_000 },
    )
    .toBe(true);
});
