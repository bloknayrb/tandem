import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Locator, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { E2E_APP_DATA_DIR } from "../../scripts/e2e-paths.js";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import type { ToolResponse } from "../../src/shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** This suite's own backend (#1492). The perf harness reuses `McpTestClient` against ITS pair by passing a url — see the constructor. */
const MCP_URL = `http://127.0.0.1:${E2E_MCP_PORT}/mcp`;

/**
 * Annotation dir used by the E2E test server. Used to clean up orphaned
 * envelopes in cleanupFixtureDir so the rename-recovery feature (#313) doesn't
 * mistake a deleted fixture path as a rename signal for the next test's
 * identical fixture.
 *
 * Imports the shared constant rather than re-spelling the literal: a second
 * copy that drifts sends `cleanupFixtureDir` at the wrong directory, and the
 * failure mode is the orphaned-envelope cascade `scripts/e2e-server.mjs`
 * documents — "expected 1 annotation card, received N" across the whole suite.
 *
 * **Deliberately does not consult `process.env.TANDEM_APP_DATA_DIR`**, which it
 * used to. `playwright.config.ts` sets that var inside `webServer.env` — the
 * server child's environment — and never on the runner's `process.env`, so in
 * this process it only ever holds a developer's own ambient export. Reading it
 * therefore had no reachable correct case and one wrong one: cleanup aimed at
 * the developer's dir while the server wrote envelopes here, silently no-oping
 * against the directory that matters and re-creating the very cascade above.
 */
const E2E_ANNOTATIONS_DIR = path.join(E2E_APP_DATA_DIR, "annotations");

/**
 * MCP test client using the SDK's built-in Client + StreamableHTTPClientTransport.
 */
export class McpTestClient {
  private client: Client;
  private connected = false;
  private readonly mcpUrl: string;

  /** Defaults to the E2E backend; the perf harness passes its own pair's url. */
  constructor(mcpUrl: string = MCP_URL) {
    this.mcpUrl = mcpUrl;
    this.client = new Client({ name: "tandem-e2e-test", version: "1.0.0" });
  }

  async connect(retries = 5, delayMs = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
        await this.client.connect(transport);
        this.connected = true;
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error("Not connected — call connect() first");
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const content = result.content as Array<{ type: string; text?: string }>;
      const msg = content?.find((c) => c.type === "text")?.text ?? "unknown error";
      throw new Error(`MCP tool "${name}" failed: ${msg}`);
    }
    const content = result.content as Array<{ type: string; text?: string }>;
    const textItem = content?.find((c) => c.type === "text");
    if (textItem?.text) {
      try {
        return JSON.parse(textItem.text);
      } catch {
        return textItem.text;
      }
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

/** Create a temp directory and copy fixture files into it. */
export function createFixtureDir(...fixtureNames: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-"));
  const fixturesDir = path.join(__dirname, "fixtures");
  for (const name of fixtureNames) {
    fs.copyFileSync(path.join(fixturesDir, name), path.join(tmpDir, name));
  }
  return tmpDir;
}

/**
 * Clean up a temp directory AND its orphaned annotation envelopes.
 *
 * The rename-recovery feature (#313) re-associates an orphaned annotation
 * envelope to a new file when: (a) the new file's content hash matches the
 * old envelope's stored hash, and (b) the old file path no longer exists. In
 * E2E tests, all tests share the same fixture content (`sample.md`), so after
 * the fixture dir is deleted the old path "vanishes" and the next test's fresh
 * fixture (identical content → same hash) satisfies both conditions — causing
 * stale annotations from a previous test to appear unexpectedly.
 *
 * Fix: delete the annotation envelopes for files in `dir` BEFORE removing the
 * dir itself, so recovery never sees the orphaned envelope.
 */
export function cleanupFixtureDir(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      try {
        fs.rmSync(path.join(E2E_ANNOTATIONS_DIR, `${docHash(abs)}.json`), { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Switch the side panel to the Annotations tab.
 *
 * Wave 4 changed the default `primaryTab` setting to "chat", so in the
 * tabbed layout the SidePanel (which contains annotation cards) is mounted
 * but hidden via `display: none` behind the Chat tab. Any E2E test that
 * asserts `annotation-card-*` elements are VISIBLE must call this helper
 * after `page.goto("/")` — otherwise the cards exist in the DOM but
 * Playwright reports them as hidden.
 *
 * **Silent-failure warning**: because the cards are still mounted when
 * hidden, `locator(...).count()` will return a non-zero value even without
 * this helper. Tests that assert on `count` instead of `toBeVisible` will
 * pass misleadingly. Prefer `toBeVisible` for annotation-card assertions,
 * or call this helper regardless.
 *
 * In three-panel layout mode, both panels are rendered side-by-side with
 * static headers instead of tab buttons — there is no `annotations-tab`
 * testid in that mode. The helper detects this and no-ops, so tests that
 * switch layout mid-flight still work.
 */
export async function switchToAnnotationsTab(page: Page): Promise<void> {
  const tab = page.locator("[data-testid='annotations-tab']");
  // In three-panel mode the tab button does not exist — bail silently.
  if ((await tab.count()) === 0) return;
  await tab.click();
  // The display toggle is synchronous CSS; no wait needed, but we return
  // control to the caller only after the click has resolved.

  // FilterBar defaults to collapsed since feat(panels): collapsible filter bar
  // (PR #578). Expand it so callers can immediately interact with filter controls.
  const toggle = page.locator("[data-testid='filter-bar-toggle']");
  if ((await toggle.count()) > 0) {
    await toggle.click();
  }
}

/**
 * Select a locator's text and wait until the selection actually took.
 *
 * `locator.selectText()` is a one-shot `createRange()` + `addRange()`.
 * ProseMirror runs its own DOM-selection observer and re-asserts its internal
 * selection onto the DOM, so a programmatic range that lands in the wrong moment
 * is silently clobbered: the selection comes back COLLAPSED, no `selectionUpdate`
 * fires, and the selection popup therefore never appears — and never will, because
 * nothing in the client retries. It does not need to: a real pointer drag or
 * shift+arrow selection emits genuine selectionchange events, so only a
 * programmatic one can lose this race.
 *
 * Measured on master before this helper existed: roughly one failure per 28-test
 * run of `toolbar-redesign.spec.ts`, roaming across whichever test happened to
 * lose. Diagnosis: on a passing run the selectionchange log reads
 * `COLLAPSED(click), range:N, range:N`; on a failing one the same slot reads
 * `COLLAPSED(click), COLLAPSED`. The editor is healthy at that point — focused,
 * contenteditable, correct paragraph count and text — the selection simply is not
 * there.
 *
 * Re-issuing it is enough, so poll until the selection is really there. Two
 * details of that check are load-bearing, because the obvious version of it
 * reports success in cases where nothing was selected:
 *
 * - **It asserts the range is inside `target`, not merely that the document has
 *   one.** The clobber path restores ProseMirror's own `state.selection`, which
 *   is collapsed only when the last real interaction was a click. Called with a
 *   non-empty selection already standing, a document-wide emptiness check would
 *   read the *previous* range and pass without ever selecting `target`.
 * - **It re-reads after a settle rather than immediately.** On the selection
 *   path `DOMObserver.onSelectionChange` flushes synchronously, but a flush
 *   queued by a *content* mutation is deferred 20ms by `flushSoon()`, and
 *   `flush()` ends by restoring `currentSelection` via `selectionToDOM`. An
 *   immediate read can therefore observe a selection that is already doomed —
 *   the poll passes, the helper returns, and the caller fails exactly as it did
 *   before this helper existed.
 *
 * Prefer this over a bare `selectText()` anywhere the test then expects the
 * selection popup.
 */
export async function selectTextStable(target: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await target.selectText();
        return target.evaluate(async (el) => {
          // Outlast a mutation-triggered `flushSoon()` (20ms) so the value read
          // below is the selection that survives, not one about to be undone.
          await new Promise((resolve) => setTimeout(resolve, 25));
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
          return el.contains(sel.getRangeAt(0).commonAncestorContainer);
        });
      },
      {
        timeout: 5_000,
        message:
          "programmatic selection never took — ProseMirror clobbered every attempt (see selectTextStable)",
      },
    )
    .toBe(true);
}

/**
 * Open the selection popup's annotate mode. Wave M (PR #776) split the popup
 * into two surfaces — selection shows the action surface (formatting +
 * highlight swatches + Annotate button); clicking Annotate reveals the
 * textarea-bearing annotate mode (`popup-annotation-input`,
 * `popup-comment-submit`, `popup-note-submit`). Tests that interact with the
 * textarea or the footer controls must call this helper after selecting text.
 *
 * To actually CREATE the annotation, follow this with `submitAnnotation` — the
 * two `*-submit` ids above now sit on audience-toggle segments and no longer
 * submit anything on their own.
 */
export async function openAnnotatePopup(page: Page): Promise<void> {
  const annotateBtn = page.locator("[data-testid='popup-annotate-btn']");
  await expect(annotateBtn).toBeVisible({ timeout: 3_000 });
  await annotateBtn.click();
  await expect(page.locator("[data-testid='popup-annotation-input']")).toBeVisible({
    timeout: 3_000,
  });
}

/**
 * Submit the annotate composer's draft to one audience.
 *
 * `popup-note-submit` / `popup-comment-submit` are no longer submit buttons.
 * They are the two segments of an audience toggle, and the composer commits
 * through a single `popup-annotation-submit` button. Their names are kept
 * because the testid set may gain selectors but never lose one (Critical
 * Rule 7) — so a bare `.click()` on either now *silently* selects an audience
 * and submits nothing, which is why every call site routes through here.
 *
 * Two properties this asserts rather than assumes, because both are what a
 * "toggle plus commit" split can get wrong and neither fails loudly:
 *   - the segment actually took (`aria-pressed`), rather than the click
 *     landing on the sliding thumb, which is `pointer-events: none` for
 *     exactly this reason;
 *   - the commit button is enabled, so an empty-draft test that expects a
 *     no-op cannot pass by clicking a dead button.
 */
export async function submitAnnotation(page: Page, audience: "note" | "comment"): Promise<void> {
  const segment = page.locator(`[data-testid='popup-${audience}-submit']`);
  await segment.click();
  await expect(segment).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });

  const commit = page.locator("[data-testid='popup-annotation-submit']");
  await expect(commit).toBeEnabled({ timeout: 3_000 });
  await commit.click();
}

/**
 * Wait for `n` animation frames inside the page. Use after viewport resizes or
 * other DOM mutations that propagate through ResizeObserver → Svelte `$state` →
 * `$effect` → DOM, instead of `page.waitForTimeout(fixedMs)`.
 *
 * The full chain after `setViewportSize` is: CDP resize task → rAF #1 (e.g.
 * `useViewportWidth.svelte.ts:16-30` debounce) → microtask ($effect + $derived)
 * → rAF #2 (paint). Default `n=3` adds one frame of slack for CI load.
 */
export async function nextFrames(page: Page, n = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = () => (++i >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/**
 * Open the consolidated Settings modal via the brand-menu dropdown (Wave M: the
 * old standalone gear button was replaced by a menu item inside the Tandem logo
 * dropdown). Call this wherever tests previously clicked `[data-testid='settings-btn']`.
 */
export async function openSettingsViaBrandMenu(page: Page): Promise<void> {
  await page.locator("[data-testid='titlebar-brand-menu']").click();
  await page.locator("[data-testid='brand-menu-settings']").click();
}

export type RailSide = "left" | "right";

/**
 * A rail's resize-handle testid — the presence of which is how every spec
 * detects rail visibility. The shells' own testids (`rail-float-left` /
 * `rail-float-right`) cannot serve: they are conditional on the floating state,
 * so their absence does not mean the rail is closed.
 *
 * The right entry is NOT `right-panel-resize-handle`: App.svelte overrides the
 * snippet's default at the call site. That asymmetry is a documented blind spot
 * of the testid extractor (docs/design-system-impl/testid-manifest.md) — the
 * snapshot only ever sees the template form, so a rename of the call-site
 * literal slips past testid-coverage.test.ts and breaks specs at runtime with
 * nothing catching it at source level. Hence one copy, here — reference it
 * rather than re-typing either literal.
 */
export const RAIL_HANDLE_TESTID: Record<RailSide, string> = {
  left: "left-panel-resize-handle",
  right: "panel-resize-handle",
};

const RAIL_TOGGLE_KEY: Record<RailSide, string> = {
  left: "Alt+Shift+ArrowLeft",
  right: "Alt+Shift+ArrowRight",
};

/**
 * Put a rail into the requested visibility state and return its handle locator.
 *
 * Toggles only when needed, so a spec never has to assume the product defaults
 * (`leftPanelVisible: false` / `rightPanelVisible: true` today) — if one flips,
 * the count assertion here reports it rather than a later assertion measuring a
 * phantom. Wave M removed the titlebar toggle buttons; keyboard drives it.
 */
export async function setRailVisible(
  page: Page,
  side: RailSide,
  visible: boolean,
): Promise<Locator> {
  const handle = page.locator(`[data-testid='${RAIL_HANDLE_TESTID[side]}']`);
  const alreadyVisible = (await handle.count()) > 0;
  if (alreadyVisible !== visible) {
    await page.keyboard.press(RAIL_TOGGLE_KEY[side]);
  }
  await expect(handle).toHaveCount(visible ? 1 : 0, { timeout: 3_000 });
  return handle;
}

/** Success-payload shape for `tandem_status` consumed by `cleanupAllOpenDocuments`. */
type StatusData = {
  openDocuments?: Array<{ documentId: string }>;
};

/**
 * Close every document the server thinks is open. Safe to call in afterEach
 * even when a test opened nothing — the loop just no-ops on an empty list.
 * Swallows errors because the server may already be shutting down.
 */
export async function cleanupAllOpenDocuments(mcp: McpTestClient): Promise<void> {
  try {
    // McpTestClient.callTool throws on SDK-level errors but returns the parsed
    // envelope on success. Server errors still come through as `{ error: true, ... }`
    // in the envelope — the `error === false` narrow picks the success arm.
    const status = (await mcp.callTool("tandem_status")) as ToolResponse<StatusData>;
    const docs = status.error === false ? (status.data.openDocuments ?? []) : [];
    await Promise.all(docs.map((d) => mcp.callTool("tandem_close", { documentId: d.documentId })));
  } catch (err) {
    // Server may be shutting down — log so genuine regressions aren't silently
    // swallowed by an afterEach hook.
    console.warn("cleanupAllOpenDocuments failed:", err);
  }
}
