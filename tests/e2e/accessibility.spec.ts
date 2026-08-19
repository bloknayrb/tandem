import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import path from "path";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openSettingsViaBrandMenu,
  selectTextStable,
  switchToAnnotationsTab,
} from "./helpers";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------
// These scans are deliberately NOT scoped with `.include("#root")`.
//
// The slash-command menu is built in a ProseMirror plugin —
// `slash-menu/extension.ts` does `document.body.appendChild(...)` — which makes
// it a *sibling* of `#root`, not a descendant. Every scan this file ran before
// #1291's sweep used `.include("#root")` and therefore skipped it silently: a
// `role="listbox"` with options, never once audited, with no failure to say so.
// Scanning the whole document and subtracting known noise fails loudly when a
// new surface appears; an allowlist fails quietly when one escapes it.
//
// `utils/portal.ts` exists but has zero call sites, and every other overlay is
// rendered inline in `App.svelte` (several carry comments saying so explicitly,
// left behind by past un-portaling refactors). The slash menu is the only
// out-of-root surface today — but that is a fact that can change, which is the
// argument for not re-introducing the allowlist.
//
// ---------------------------------------------------------------------------
// Known gap: axe cannot see inside the editable surface
// ---------------------------------------------------------------------------
// `[contenteditable]` / `.ProseMirror` are excluded because axe cannot evaluate
// them meaningfully. For a document editor that is not a footnote — it means
// these scans never cover the surface a user spends all of their time in.
// Specifically unaudited here:
//   - authorship colors (--tandem-author-user / --tandem-author-claude), applied
//     as inline text color via data-tandem-author attributes
//   - annotation underline decorations (highlight / comment / note)
//   - highlight-on-text contrast (colored backgrounds behind body copy)
// Those three are covered by computed-style contrast probes instead — axe is
// not the only tool that can answer a contrast question. See
// `editor-contrast.spec.ts`. Any pass reported from THIS file must carry that
// qualifier with it.
// ---------------------------------------------------------------------------

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", {
    filePath: path.join(tmpDir, "sample.md"),
  });
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

/**
 * One scan, one set of rules. This used to be four hand-copied blocks; with a
 * surface table it would have been twenty. Copy-paste across a growing surface
 * list guarantees the exclusions drift apart, and an audit only means something
 * if every surface was measured the same way.
 */
async function scan(page: Page) {
  return (
    new AxeBuilder({ page })
      .exclude("[contenteditable]")
      .exclude(".ProseMirror")
      // The muted-affordance fade is `opacity: 0.4`, which axe correctly reads
      // as failing contrast. It is a deliberate design override (PR #760).
      //
      // This exclusion used to name `.tandem-status-pill` — the whole pill —
      // citing that same fade. The fade had since moved to `.status-faint`, a
      // child wrapper, split out precisely so the AI indicator (its sibling)
      // could stay bright. So the exclusion was suppressing the AI indicator,
      // the held-count pill and the word-count button, all rendered at full
      // opacity, on the strength of a justification that no longer described
      // them. Narrowed to the element the rationale actually covers.
      .exclude(".status-faint")
      .disableRules([
        // The WAI-ARIA APG closable-tabs pattern places a close button inside
        // role="tab". axe's nested-interactive rule fires on this
        // well-established pattern; the close button is fully operable by
        // pointer and by assistive technology via its aria-label.
        "nested-interactive",
        // `region` is an axe **best-practice** rule, not a WCAG one. Its two
        // WCAG-mapped relatives — `page-has-main` and `landmark-one-main` — are
        // left ENABLED and pass, which is the part that matters and the part
        // that was genuinely broken until this pass added `role="main"` and the
        // complementary rails.
        //
        // What still trips `region` is transient floating chrome: the selection
        // popup, the slash menu, the decorations menu, and the drag handles
        // between rails. Satisfying it would mean wrapping every popover in its
        // own landmark, which makes the landmark map worse, not better —
        // landmarks are meant to be few and stable, and a screen-reader user
        // gains nothing from a landmark that exists for 200ms while a menu is
        // open. Accepted deliberately; recorded in docs/a11y-gate-results.md.
        "region",
        // The command palette uses the `aria-activedescendant` pattern:
        // keyboard focus stays on the input and arrow keys move the selection,
        // scrolling `#palette-results` as they go. axe's scrollable-region /
        // focusable-content rules look for a focusable element *inside* the
        // scroller and, finding `role="option"` items that are correctly NOT
        // in the tab order, report it as keyboard-unreachable. It isn't — this
        // is the documented APG combobox behaviour. The keyboard suite asserts
        // the arrow-key path works rather than taking axe's word either way.
        //
        // Only the RULE id belongs here. `focusable-element` /
        // `focusable-content` appear alongside it in the results but are
        // *checks* within this rule; passing them to disableRules makes axe
        // throw `unknown rule`. It fails loudly, which is the good outcome.
        "scrollable-region-focusable",
      ])
      .analyze()
  );
}

/** Apply a theme directly.
 *
 * This bypasses `useTheme.svelte.ts`'s store-driven `$effect` rather than
 * driving the real preference. It holds for the duration of a test because
 * nothing re-fires that effect in a headless run, and it is what the previous
 * revision of this file relied on. It would break if a second `applyTheme()`
 * caller ever appeared.
 */
async function setTheme(page: Page, theme: "light" | "dark" | "warm") {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}

/**
 * Wait until nothing is still animating, then scan.
 *
 * This is not defensive padding — without it the contrast numbers are fiction.
 * The theme swap retints tokens through CSS transitions, and axe samples
 * whatever the pixels are at that instant. The first run of this suite reported
 * a *dark*-theme foreground (#b4c6ff) over a *light*-theme background
 * (#e7ecfe): a pair that cannot coexist in any settled state, and therefore a
 * statement about the instrument rather than the product. Surfaces also animate
 * in on open (200-260ms), which is a second source of the same error.
 *
 * `getAnimations()` covers CSS transitions and Web Animations alike, so this
 * waits for the real condition instead of guessing a duration.
 *
 * Two things it must NOT do, both learned by hanging:
 *
 *   - Wait on infinitely-repeating animations. A looping pulse (the working
 *     indicator, a spinner) never resolves `finished`, by definition. Waiting on
 *     one is not a slow settle, it is a settle that can never happen — this hung
 *     the whole 30s test budget the first time such an element was on screen.
 *     They are also irrelevant here: a loop has no final state to sample.
 *   - Wait without a ceiling. Even among finite animations, a scan that blocks
 *     forever reports as a timeout rather than as a contrast result, which tells
 *     nobody anything about the palette.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) !== Number.POSITIVE_INFINITY);
    await Promise.race([
      Promise.allSettled(finite.map((a) => a.finished)),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function bootEditor(page: Page) {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });
}

async function bootWithContent(page: Page) {
  await page.goto("/");
  await expect(page.locator(".tiptap p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
}

/** Select the first paragraph — the precondition for the selection popup. */
async function selectFirstParagraph(page: Page) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await selectTextStable(page, editor.locator("p").first());
}

type Surface = {
  name: string;
  /** Leaves the surface visible and ready to scan. */
  open: (page: Page) => Promise<void>;
  /**
   * Undo state that `open` created OUTSIDE the per-test fixture document, and that
   * would therefore survive `cleanupAllOpenDocuments` into later surfaces' scans.
   *
   * Deliberately per-surface rather than a blanket `afterEach`: the only thing needing
   * it today clears chat, which is a DURABLE server-side delete, and the backend
   * `webServer` runs with `reuseExistingServer: !CI` — so locally this can execute
   * against a dev server holding the developer's real app data rather than the
   * throwaway `TANDEM_APP_DATA_DIR` the e2e server boots with. Running it after every
   * test would multiply that by the whole surface table for no benefit.
   */
  close?: (page: Page) => Promise<void>;
};

/**
 * Openers are lifted from the spec that already drives each surface, rather
 * than re-derived here. A hand-rolled sequence that *looks* like it opens a
 * surface but silently doesn't produces a clean scan of the wrong DOM — which
 * is indistinguishable from a pass.
 */
const SURFACES: Surface[] = [
  {
    name: "app chrome",
    open: bootEditor,
  },
  {
    name: "chat panel",
    // No test had ever asserted on the chat panel, so it had never been
    // audited. It is always *mounted* — ChatPanel and SidePanel toggle by CSS
    // display so their local state survives panel switches — which is exactly
    // why the tab click is required: a display:none subtree is present in the
    // DOM but not visible, and axe skips hidden content.
    open: async (page) => {
      await bootEditor(page);
      const tab = page.locator("[data-testid='chat-tab']");
      if ((await tab.count()) > 0) await tab.click();
      await expect(page.locator("[data-testid='chat-panel']")).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    name: "chat panel (with messages)",
    // The surface above scans the panel in its EMPTY state, which is a different
    // surface, not a lesser version of this one — so this is added alongside it rather
    // than replacing it. Export, Clear and the whole chat header row are gated on
    // `messages.length > 0` (ChatPanel.svelte), so before #1454 none of them had ever
    // been in a scanned DOM. Same reasoning as "annotation card" above: an empty
    // container is not the surface.
    //
    // Seeded over MCP rather than through the composer on purpose. A UI send dispatches
    // `tandem:addressed-ai` and can raise the push-delivery notice, which would drag an
    // unrelated component into the scan and make a failure here ambiguous.
    //
    // NOT covered by this surface: the unread pill. `useChatState` acknowledges every
    // claude message while the chat tab is active, and this surface activates it, so
    // `unreadCount > 0` cannot hold *here*. That is a property of this surface, NOT an
    // impossibility — `chatVisible` requires the chat TAB to be active (App.svelte), and
    // these scans are deliberately unscoped (see the header), so seeding while the
    // Annotations tab is active would leave the pill unacknowledged and in scope. #1454
    // asks for that; it is a separate surface and is still unaudited.
    open: async (page) => {
      await bootEditor(page);
      await mcp.callTool("tandem_reply", {
        text: "Contrast probe — a reply long enough to wrap across more than one line in the panel, so the message body, its timestamp and the header action row are all laid out and scannable.",
      });
      const tab = page.locator("[data-testid='chat-tab']");
      if ((await tab.count()) > 0) await tab.click();
      await expect(page.locator("[data-testid='chat-panel']")).toBeVisible({ timeout: 5_000 });
      // Load-bearing: this is what proves the header row is actually present. Without it
      // a seed that silently failed would still produce a clean scan of the empty panel.
      await expect(page.locator("[data-testid='clear-chat-btn']")).toBeVisible({
        timeout: 10_000,
      });
    },
    // Chat lives in CTRL_ROOM, not in the per-test fixture document, so the seeded
    // message outlives `cleanupAllOpenDocuments`. Without this the theme loop reruns the
    // table three times and the SECOND pass's "chat panel" (empty) surface would scan a
    // panel that still holds this message — i.e. surface order silently becomes
    // load-bearing and the empty-state audit quietly stops auditing the empty state.
    close: async () => {
      try {
        await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}/api/chat`, { method: "DELETE" });
      } catch {
        // Best-effort: a failure here must not mask the assertion that just ran.
      }
    },
  },
  {
    name: "annotations panel (empty)",
    open: async (page) => {
      await bootWithContent(page);
      await switchToAnnotationsTab(page);
    },
  },
  {
    name: "annotation card",
    // An annotation must actually EXIST for this to audit anything. The first
    // version of this suite scanned the annotations panel in its empty state
    // and reported it clean — while `AnnotationCardHeader` renders
    // fg-muted, fg-subtle and fg-faint adjacent in a single header row, and a
    // rank inversion between two of those tiers went undetected through a full
    // green run. An empty container is not the surface.
    open: async (page) => {
      await bootWithContent(page);
      await mcp.callTool("tandem_comment", {
        from: 5,
        to: 15,
        text: "Contrast probe — exercises the muted/subtle/faint header stack.",
      });
      await switchToAnnotationsTab(page);
      await expect(page.locator("[data-testid^='annotation-card-']").first()).toBeVisible({
        timeout: 10_000,
      });
    },
  },
  {
    name: "outline panel",
    open: async (page) => {
      await bootWithContent(page);
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      await expect(page.locator("[data-testid='outline-panel']")).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    name: "settings modal",
    open: async (page) => {
      await bootEditor(page);
      await openSettingsViaBrandMenu(page);
      await expect(page.locator("[data-testid='settings-modal']")).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    name: "brand menu",
    open: async (page) => {
      await bootEditor(page);
      await page.locator("[data-testid='titlebar-brand-menu']").click();
      await expect(page.locator("[data-testid='titlebar-brand-menu-popover']")).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "command palette",
    open: async (page) => {
      await bootEditor(page);
      await page.keyboard.press("Control+Shift+P");
      await expect(page.locator("[data-testid='command-palette']")).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    name: "find/replace bar",
    open: async (page) => {
      await bootWithContent(page);
      await page.keyboard.press("Control+g");
      await expect(page.locator("[data-testid='find-replace-bar']")).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "new-tab launcher",
    open: async (page) => {
      await bootEditor(page);
      await page.locator("[data-testid='open-file-btn']").click();
      await expect(page.locator("[data-testid='new-tab-search']")).toBeVisible({ timeout: 5_000 });
    },
  },
  {
    name: "decorations menu",
    open: async (page) => {
      await bootEditor(page);
      await page.getByTestId("decorations-menu-caret").click();
      await expect(page.locator("[data-testid='decorations-menu']")).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "slash command menu",
    // The surface that `.include("#root")` had been hiding. See the scope note.
    open: async (page) => {
      await bootWithContent(page);
      await page.locator(".tiptap p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" /h2");
      await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "selection popup",
    open: async (page) => {
      await bootWithContent(page);
      await selectFirstParagraph(page);
      await expect(page.getByRole("toolbar", { name: "Selection tools" })).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "link input dialog",
    open: async (page) => {
      await bootWithContent(page);
      await selectFirstParagraph(page);
      // dispatchEvent rather than click: Tiptap clears the selection on a real
      // mousedown before the popover renders (mirrors the handler's
      // preventDefault path).
      const linkBtn = page.locator("[data-testid='formatting-bar'] [aria-label='Link']").first();
      await linkBtn.dispatchEvent("mousedown", { bubbles: true, cancelable: true });
      await expect(page.locator("[data-testid='toolbar-link-input']")).toBeVisible({
        timeout: 5_000,
      });
    },
  },
  {
    name: "activity tray",
    open: async (page) => {
      await bootEditor(page);
      await page.locator("[data-testid='activity-pill']").click();
      await expect(page.locator("[data-testid='activity-tray']")).toBeVisible({ timeout: 5_000 });
    },
  },
];

// Warm is not a spare theme. It carries its own surface ramp (surface-sunk at
// 0.920 against light's 0.96) while inheriting :root's de-emphasis ladder and
// status family wholesale — so it is where the retuned ladder's margins are
// thinnest, and index.html's recorded worst cases (6.65 / 5.75 / 4.73) are all
// warm numbers. token-contrast and editor-contrast cover warm as declared token
// pairs; axe is the only instrument here that sees what a component actually
// composites and paints.
for (const theme of ["light", "dark", "warm"] as const) {
  test.describe(`WCAG AA — ${theme} mode`, () => {
    for (const surface of SURFACES) {
      test(`${surface.name} has no violations`, async ({ page }) => {
        // Theme first, and before the document exists — so the surface renders
        // in its final palette rather than transitioning into it while axe
        // reads the pixels. Re-applied after open because the app's own
        // `$effect` sets the attribute from the settings store during boot.
        await page.addInitScript(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        try {
          await surface.open(page);
          await setTheme(page, theme);
          await settle(page);
          const results = await scan(page);
          expect(results.violations).toEqual([]);
        } finally {
          // In `finally` so a failing scan still cleans up — otherwise the first red
          // surface poisons every later one and the real failure gets buried in noise.
          await surface.close?.(page);
        }
      });
    }
  });
}
