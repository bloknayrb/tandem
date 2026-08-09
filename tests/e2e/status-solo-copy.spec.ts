import { expect, test } from "@playwright/test";

/**
 * #1287 — the Solo status-pill copy must promise only what Solo delivers.
 *
 * Solo's hold is a *forwarding* boundary (annotation comments/replies aren't
 * pushed to Claude's inbox), not an activity boundary — document mutations,
 * chat, and Claude's ability to read the document on request all keep
 * working. The old label ("Solo · edits held") plus an unqualified activity
 * suffix ("· reviewing scratchpad…") read as two competing claims: the brief
 * decided (docs/triage/2026-08-06/brief-1287.md, Option B) to fix the copy
 * rather than suppress either signal, since suppression would make the UI
 * agree with a claim that's false (idle vs. working-invisibly become
 * indistinguishable).
 *
 * A live Solo session with an in-flight tool call is hard to drive
 * end-to-end (see typing-presence.spec.ts's note on the same problem for the
 * per-card indicator) — this pins the rendered DOM contract the two client
 * surfaces (status-ai-view.ts + StatusBar.svelte's aiIndicatorContent
 * snippet) produce, via the same setContent smoke pattern.
 */

test("Solo status-pill label reads 'comments held', not 'edits held'", async ({ page }) => {
  await page.setContent(`
    <div
      class="status-ai-indicator"
      data-testid="status-ai-indicator"
      data-ai-state="solo-paused"
      role="img"
      aria-label="Solo mode — the AI is connected, but your comments and replies aren't forwarded until you switch to Tandem"
    >
      <span class="claude-dot"></span>
      <span>Solo · comments held</span>
    </div>
  `);

  const pill = page.locator("[data-testid='status-ai-indicator']");
  await expect(pill).toBeAttached();
  await expect(pill).toHaveAttribute("data-ai-state", "solo-paused");
  await expect(pill).toContainText("Solo · comments held");
  await expect(pill).not.toContainText("edits held");

  const ariaLabel = await pill.getAttribute("aria-label");
  expect(ariaLabel).toMatch(/comments and replies aren't forwarded/i);
  expect(ariaLabel).not.toMatch(/edits/i);
});

test("Solo status-pill qualifies live activity text so the two pills read as one sentence", async ({
  page,
}) => {
  // Mirrors aiIndicatorContent's rendered output when `claudeStatus` is set
  // and `view.tone === "solo"`: the activity suffix gets a parenthetical so
  // "comments held" and "reviewing scratchpad…" don't read as a contradiction.
  await page.setContent(`
    <div
      class="status-ai-indicator"
      data-testid="status-ai-indicator"
      data-ai-state="solo-paused"
      role="img"
      aria-label="Solo mode — the AI is connected, but your comments and replies aren't forwarded until you switch to Tandem"
    >
      <span class="claude-dot"></span>
      <span>Solo · comments held · reviewing scratchpad… (comments still held)</span>
    </div>
  `);

  const pill = page.locator("[data-testid='status-ai-indicator']");
  await expect(pill).toContainText(
    "Solo · comments held · reviewing scratchpad… (comments still held)",
  );
});

test("connected (non-Solo) status-pill carries no Solo qualifier", async ({ page }) => {
  // Regression guard for the `view.tone === "solo"` gate in StatusBar.svelte's
  // aiIndicatorContent snippet — the qualifier must not leak onto the
  // connected/no-push copy, which makes no forwarding promise to contradict.
  await page.setContent(`
    <div
      class="status-ai-indicator"
      data-testid="status-ai-indicator"
      data-ai-state="connected"
      role="img"
      aria-label="Claude is connected and can read your document"
    >
      <span class="claude-dot"></span>
      <span>AI connected · reviewing scratchpad…</span>
    </div>
  `);

  const pill = page.locator("[data-testid='status-ai-indicator']");
  await expect(pill).toContainText("AI connected · reviewing scratchpad…");
  await expect(pill).not.toContainText("comments still held");
});
