import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import path from "path";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import {
  assessIncompleteNode,
  checkIncompleteBaseline,
  colorContrastNodeCount,
  describeVerdict,
  type IncompleteWaiver,
  incompleteMessageKey,
  staleWaivers,
} from "./axe-incomplete.js";
import { sampleIncompleteNodes } from "./axe-incomplete-sampler.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  openSettingsViaBrandMenu,
  selectTextStable,
  submitAnnotation,
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
  await selectTextStable(editor.locator("p").first());
}

/**
 * Why axe leaves color-contrast nodes `incomplete` (#1721, measured 2026-10-30
 * across all 51 scans; the per-node numbers are in docs/a11y-gate-results.md).
 * Its own `messageKey` puts every one in four buckets: `nonBmp` (text made only
 * of symbol glyphs — ⇅ ▾ ↵ ●), `shortTextContent` (one-letter text — the B/I/S
 * buttons), `bgOverlap`, and `elmPartiallyObscured(ing)`. None is the modern
 * colour syntax and none is the annotation card's tint. The loop at the bottom
 * decides every such node itself — measured from computed style, or proven to
 * paint no pixel — so a node in this bucket cannot fade to any contrast with
 * the run green.
 *
 * Grading split, stated so nobody mistakes it for an accident: a node axe
 * DECIDES is graded by axe (4.5:1 for all normal text); a node it leaves
 * incomplete is graded by `requiredRatio`, which gives symbol-only glyphs 3:1
 * under SC 1.4.11. Telling axe to decide glyphs itself (`ignoreUnicode: false`)
 * would grade them at 4.5:1 instead — a policy change, not a cleanup.
 *
 * A node computed style cannot measure fails unless its surface carries a
 * waiver for it (`Surface.incompleteWaivers`). The only case today: the
 * annotation rail's sort (⇅) and filter (▾) glyphs BEHIND an open
 * `aria-modal` dialog's translucent scrim — the page beneath is out of reach
 * until it closes, and the same two glyphs are measured unobscured on every
 * other surface. A waiver excuses only an unmeasurable node whose every reason
 * matches `expect`, never one that measured and failed; one that excuses
 * nothing in a theme fails that theme's run.
 */
function behindModalScrim(scrim: RegExp, reason: string): Record<string, IncompleteWaiver> {
  return Object.fromEntries(
    [
      '[data-testid="annotation-sort-toggle"] <span> "⇅"',
      '[data-testid="filter-bar-toggle"] <span> "▾"',
    ].map((d) => [d, { reason, expect: scrim }]),
  );
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
  /**
   * Keyed exemptions for color-contrast nodes axe left `incomplete` on this
   * surface that computed style cannot measure either, keyed by the sampler's
   * descriptor and applying in every theme. See `behindModalScrim`.
   */
  incompleteWaivers?: Record<string, IncompleteWaiver>;
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
    // claude message while the chat tab is active in the focused window (#2168 added the
    // focus term; Playwright's focus emulation keeps the page focused), and this surface
    // activates it, so
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
        await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/chat`, { method: "DELETE" });
      } catch {
        // Best-effort: a failure here must not mask the assertion that just ran.
      }
    },
  },
  {
    name: "chat pickup row",
    // The row under the user's latest message only exists once a USER message does, and
    // no MCP tool writes one, so this surface sends through the composer — accepting that
    // a UI send can also raise the push-delivery notice, which is then scanned too. Kept
    // separate from "chat panel (with messages)" so that surface's scan stays unambiguous.
    // The waiting row is the one scanned: it is the muted-colour variant, the contrast risk.
    open: async (page) => {
      await bootEditor(page);
      const tab = page.locator("[data-testid='chat-tab']");
      if ((await tab.count()) > 0) await tab.click();
      const input = page.locator("[data-testid='chat-composer-input']");
      await input.fill("Contrast probe for the pickup row");
      await input.press("Enter");
      await expect(page.locator("[data-testid='chat-pickup-status']")).toHaveAttribute(
        "data-pickup",
        "waiting",
        { timeout: 10_000 },
      );
    },
    close: async () => {
      try {
        await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/chat`, { method: "DELETE" });
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
    //
    // BOTH author tints, not just one. Cards are tinted by AUTHOR, so a single
    // Claude comment renders the whole header stack on --tandem-author-claude-bg
    // and leaves --tandem-author-user-bg unscanned — the same "an empty
    // container is not the surface" mistake one level in. The note below is a
    // real user annotation and is the only way to get the user tint on screen:
    // notes are user-only by ADR-027, so no MCP tool can create one.
    //
    // #1721 history, settled 2026-10-30. When it was filed, painting the note
    // card `#4a4a4a` — mid-grey behind dark body text — was reported as
    // `violations: []` in all three themes, and the mechanism was left open.
    // Re-run with the tint painted in BOTH `:root` and the dark block of
    // index.html (dark overrides `--tandem-author-user-bg` with its own hex, so
    // a `:root`-only mutation never reaches it — which is why the 2026-09-06
    // re-measure saw dark stay green), all three themes now FAIL on
    // `violations`. The card was never in the `incomplete` bucket: this
    // surface's four incomplete nodes are the side panel's ⇅/▾ glyphs, the
    // collapse-filters glyph and the Private pill, and every one of them is
    // measured by the per-node gate in the loop below. Why axe leaves nodes
    // incomplete at all is recorded on `behindModalScrim`.
    //
    // What the note is worth: it puts a second card variant, and the user
    // tint, through every rule — roles, names, the visually-hidden badge word,
    // the Private pill, and color-contrast itself.
    //
    // And two things nothing covers anywhere: axe's color-contrast rule
    // evaluates TEXT, so the highlight icon's `<svg>` fill against the card tint
    // and the note dot's hollow `<span>` border are unevaluated by construction.
    // `token-contrast.spec.ts` covers what is expressible as a token pair,
    // including the import tint — which needs a `.docx` import to render and so
    // has no card here.
    open: async (page) => {
      await bootWithContent(page);
      await mcp.callTool("tandem_comment", {
        from: 5,
        to: 15,
        text: "Contrast probe — exercises the muted/subtle/faint header stack.",
      });
      await selectFirstParagraph(page);
      await openAnnotatePopup(page);
      await page
        .locator("[data-testid='popup-annotation-input']")
        .fill("Contrast probe — the user tint, which no Claude annotation can render.");
      await submitAnnotation(page, "note");
      await switchToAnnotationsTab(page);
      await expect(page.locator("[data-testid^='annotation-card-']")).toHaveCount(2, {
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
    incompleteWaivers: behindModalScrim(
      /^painted over by <div\[data-testid="settings-modal-scrim"\]>$/,
      "behind the settings modal's translucent scrim (aria-modal)",
    ),
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
    incompleteWaivers: behindModalScrim(
      /^painted over by <div\.palette-scrim>$/,
      "behind the command palette's scrim and backdrop blur (aria-modal)",
    ),
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

/**
 * The committed per-surface ceiling on axe's color-contrast `incomplete` nodes
 * (#1721, option 3). It applies to EVERY surface above, not just the annotation
 * card whose comment records why the bucket matters.
 *
 * What it buys: it makes a JUMP loud — a change that pushes more nodes into
 * the bucket reds this suite — and it forces a newly added surface to be
 * measured rather than silently unmeasured. It is not the contrast gate for
 * those nodes; the per-node verdicts in the loop are (options 1/2 on #1721).
 * Both stay: the ceiling still catches a surface that suddenly hands axe many
 * more nodes, even if each one individually measures fine.
 *
 * Read once with `readFileSync` rather than a JSON import — the file's existing
 * style, and no `resolveJsonModule` dependency.
 */
const BASELINE_FILE = JSON.parse(
  readFileSync(new URL("./axe-incomplete-baseline.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const INCOMPLETE_BASELINE = BASELINE_FILE as Record<string, number>;

/**
 * The browser the committed numbers were measured on, carried into the failure
 * message. The ceiling has no headroom (see the file's own `$comment`: padding a
 * number nobody explained is the failure mode it forbids), so the cost of a red
 * is a triage question — environment or UI — and it is asked under merge
 * pressure on a REQUIRED check. Naming both browsers in the message is what
 * makes "rule the environment out first" a one-read answer rather than an
 * investigation nobody has time for.
 */
const SEEDED_BROWSER =
  typeof BASELINE_FILE.$browser === "string" ? BASELINE_FILE.$browser : "unrecorded";

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
          // ONE binding, read by both the log and the assertion. Two independent
          // expressions is how a one-word slip to `…(results.violations)` ships a
          // permanently-green gate: violations is asserted empty on the next
          // line, so every key would seed as 0 and `observed <= baseline` would
          // always hold. The log is deliberately permanent and ungated so a
          // re-seed can read CI's numbers without a code change.
          const key = `${theme} / ${surface.name}`;
          const incompleteNodes = colorContrastNodeCount(results.incomplete);
          console.log(`axe color-contrast incomplete — ${key} = ${incompleteNodes}`);
          // #1721: every node axe could not decide is decided here instead —
          // measured from computed style, proven covered by pixels, or excused
          // by a keyed waiver on the surface. See `behindModalScrim`.
          const ccNodes = results.incomplete.find((e) => e.id === "color-contrast")?.nodes ?? [];
          const waivers = surface.incompleteWaivers ?? {};
          const samples = await sampleIncompleteNodes(
            page,
            ccNodes.map((n) => ({
              target: [...n.target],
              html: n.html,
              messageKey: incompleteMessageKey(n),
            })),
          );
          expect(samples).toHaveLength(ccNodes.length);
          const used = new Set<string>();
          const failures: string[] = [];
          const tally = { measured: 0, covered: 0, waived: 0, failure: 0 };
          for (const sample of samples) {
            const verdict = assessIncompleteNode(key, sample, waivers[sample.descriptor]);
            // Permanent and ungated, like the count line above: CI's verdicts
            // are the evidence for whatever this gate decides on a runner whose
            // browser and fonts differ from the one these were measured on.
            console.log(
              `axe incomplete verdict — ${key} — ${sample.descriptor} (${sample.messageKey}): ${describeVerdict(verdict)}`,
            );
            if (verdict.kind === "waived") used.add(sample.descriptor);
            if (verdict.kind === "failure") failures.push(verdict.message);
            tally[verdict.kind]++;
          }
          console.log(`axe incomplete tally — ${key} — ${JSON.stringify(tally)}`);
          expect(results.violations).toEqual([]);
          expect(failures, "color-contrast nodes axe left incomplete").toEqual([]);
          expect(
            staleWaivers(waivers, used),
            "waivers that excused nothing on this surface — remove them",
          ).toEqual([]);
          expect(
            checkIncompleteBaseline(
              key,
              incompleteNodes,
              INCOMPLETE_BASELINE,
              `Seeded on ${SEEDED_BROWSER}; this run: Chromium ${page.context().browser()?.version() ?? "unknown"}. Rule a browser/font difference out before touching the number.`,
            ),
          ).toBeNull();
        } finally {
          // In `finally` so a failing scan still cleans up — otherwise the first red
          // surface poisons every later one and the real failure gets buried in noise.
          await surface.close?.(page);
        }
      });
    }
  });
}
