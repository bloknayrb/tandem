import { expect, test } from "@playwright/test";

/**
 * #651 — Claude typing-presence indicator (browser smoke).
 *
 * The live in-flight indicator is genuinely hard to observe end-to-end: the
 * server clears the awareness `working` marker synchronously when the wrapped
 * MCP tool returns (sub-millisecond for tandem_comment/_edit/_reply), so a
 * post-hoc MCP probe always races the clear. The unit tests
 * (`tests/server/typing-presence*.test.ts`) cover the set/clear lifecycle,
 * the 30s sweep, and the SSE-skip invariant against the real event queue.
 *
 * This browser smoke pins the *rendered DOM contract* the two client surfaces
 * produce — the per-card three-dot indicator and the generic status-bar pill
 * — so a markup/testid regression is caught. It mirrors the established
 * content-smoke pattern used by reply-threads.spec.ts.
 */

test("per-card typing indicator renders and clears", async ({ page }) => {
  // `setContent` ships no stylesheet, so the dots have zero size and Playwright
  // reports them "hidden" — assert on attachment + the data-attr / role
  // contract instead of pixel visibility (the CSS lives in AnnotationCard.svelte).
  await page.setContent(`
    <div data-testid="annotation-card-ann-1" data-claude-typing="true" style="position: relative; padding: 12px;">
      <div
        data-testid="claude-typing-indicator-ann-1"
        class="tandem-claude-typing"
        role="status"
        aria-label="Claude is working on this annotation"
      >dots</div>
      Comment body
    </div>
    <button data-testid="clear">clear</button>
    <script>
      document.querySelector("[data-testid='clear']").addEventListener("click", () => {
        const card = document.querySelector("[data-testid='annotation-card-ann-1']");
        card.removeAttribute("data-claude-typing");
        document.querySelector("[data-testid='claude-typing-indicator-ann-1']").remove();
      });
    </script>
  `);

  const indicator = page.locator("[data-testid='claude-typing-indicator-ann-1']");
  await expect(indicator).toBeAttached();
  await expect(indicator).toHaveAttribute("role", "status");
  await expect(indicator).toHaveAttribute("aria-label", "Claude is working on this annotation");
  await expect(page.locator("[data-testid='annotation-card-ann-1']")).toHaveAttribute(
    "data-claude-typing",
    "true",
  );

  // Tool completes → indicator clears (mirrors withTypingPresence finally{}).
  await page.locator("[data-testid='clear']").click();
  await expect(indicator).toHaveCount(0);
  await expect(page.locator("[data-testid='annotation-card-ann-1']")).not.toHaveAttribute(
    "data-claude-typing",
    "true",
  );
});

test("generic status-bar working indicator renders the tool verb", async ({ page }) => {
  await page.setContent(`
    <span
      data-testid="claude-working-indicator"
      class="claude-working-pill"
      role="status"
    >Claude is editing…</span>
  `);

  const pill = page.locator("[data-testid='claude-working-indicator']");
  await expect(pill).toBeAttached();
  await expect(pill).toContainText("Claude is editing…");
  await expect(pill).toHaveAttribute("role", "status");
});
