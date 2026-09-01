import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { PERF_MCP_PORT, PERF_WS_PORT } from "../../scripts/test-ports";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings";
import { MARGIN_TRACK_GEOMETRY } from "../../src/client/layout/editor-stage.svelte";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants";
import { McpTestClient } from "../e2e/helpers";

/**
 * v1.0 performance gate — the render / scroll / interaction path.
 *
 * Pass conditions, verbatim from docs/roadmap.md §"Performance gate":
 *   1. open-to-interactive           < 3s
 *   2. annotation create/accept      < 500ms
 *   3. no frame stall                > 100ms during a scripted scroll
 *
 * NOT covered here, deliberately: annotation-STORE cost, which
 * `tests/server/annotations/perf.test.ts` (#335) already pins, and the #609
 * atomic-update freeze, which has its own regression pin. This gate exists for
 * what those cannot see.
 *
 * This spec measures; it does not assert its way to a green build. Every
 * number is reported to stdout whether it passes or fails, because the gate's
 * output is a recorded measurement (docs/perf-gate-results.md), not a boolean.
 * Threshold assertions therefore all live in ONE block at the very end.
 *
 * ## The measured configuration
 *
 * A number here is only readable against the premises that produced it, so
 * they are set here explicitly rather than inherited from whatever the
 * defaults happen to be. See docs/perf-gate-results.md §"Harness
 * configuration" for the same list in prose:
 *
 *   - margin view forced ON (it is opt-in and OFF by default, so without this
 *     the whole margin pipeline the annotation load exists to exercise never
 *     mounts);
 *   - right rail at its shipped 300px default, left rail default;
 *   - viewport pinned 1600x900 in playwright.config.ts, because margin mode is
 *     width-derived;
 *   - load = (seeds - 1) seeded + 1 measured = 50 pending comments;
 *   - app-data wiped at SERVER START (tests/perf/perf-server.mjs), so no prior
 *     run's session is restored underneath the measurement.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(__dirname, ".generated", "perf-50-page.md");
const SEEDS = path.join(__dirname, ".generated", "perf-50-page.annotations.json");
/** A small document, opened first, so the app is warm and interactive before
 *  the measured open. Measuring a cold app would fold boot cost into a number
 *  meant to isolate document scale. */
const WARMUP_DOC = path.join(REPO_ROOT, "tests", "e2e", "fixtures", "sample.md");

const THRESHOLD_OPEN_MS = 3000;
const THRESHOLD_ANNOTATION_MS = 500;
const THRESHOLD_FRAME_STALL_MS = 100;

/**
 * The annotation load the recorded numbers are compared against — the
 * generator's `DEFAULT_ANNOTATIONS` (scripts/fixtures/make-perf-doc.mjs).
 *
 * Pinned as an ABSOLUTE number, not as "whatever the seed file requested".
 * A hand-run `make-perf-doc.mjs --annotations 14` produces a self-consistent
 * seed file (requested 14, emitted 14) that would sail through a
 * `requested === annotations.length` check while the gate measured a load
 * nobody chose.
 */
const EXPECTED_ANNOTATION_COUNT = 50;

/**
 * The string typed to prove the document is not merely painted but responsive.
 *
 * It must not occur in the fixture, or `toContainText` passes on text that was
 * already there and the check is vacuous — which is exactly what happened in
 * run 1, where the probe typed `"x"` into a document containing 418 of them.
 * Asserted against the fixture below, so a re-seeded or re-worded fixture that
 * starts containing it fails at setup instead of silently re-vacuuming the
 * assertion. Alphanumeric on purpose: no ProseMirror input rule fires on it.
 */
const INTERACTIVITY_SENTINEL = "zqx7";

interface AnnotationSeed {
  quote: string;
  text: string;
}

const results: Record<string, number> = {};

function report(label: string, value: number, threshold: number, unit = "ms") {
  const verdict = value <= threshold ? "PASS" : "FAIL";
  results[label] = value;
  console.log(
    `  [${verdict}] ${label}: ${value.toFixed(1)}${unit} (threshold ${threshold}${unit})`,
  );
}

/**
 * Unwrap an MCP tool result to its payload.
 *
 * Every tool returns `content[0].text` as a JSON envelope `{error, data}`.
 * Only tools that declare an outputSchema ALSO get `structuredContent`
 * (`mcpStructured`); the rest use `mcpSuccess` and have none — `tandem_open`
 * and `tandem_comment` among them. Reading the envelope works for both, so
 * this helper is what the harness uses everywhere rather than reaching for
 * `structuredContent` and getting `undefined` from half the tools.
 *
 * It is also the ONLY error check that works. `mcpError`
 * (src/server/mcp/response.ts) returns `{error: true, …}` WITHOUT setting
 * `isError`, and `McpTestClient.callTool` only throws on `isError` — so
 * INVALID_RANGE, RANGE_MOVED, NO_DOCUMENT and LICENSE_REQUIRED all return
 * normally. Every mutating call in this spec goes through here.
 */
function payload<T>(res: unknown): T {
  // McpTestClient.callTool already JSON.parses `content[0].text`, so what
  // arrives here is the envelope itself — NOT the raw MCP result. Reaching for
  // `.content` (or `.structuredContent`, which only outputSchema-declaring
  // tools carry at all) yields undefined.
  const envelope = res as { error?: boolean; data?: T; message?: string };
  if (envelope?.error) {
    throw new Error(`MCP tool returned an error: ${envelope.message ?? JSON.stringify(res)}`);
  }
  if (envelope?.data === undefined) {
    throw new Error(`MCP envelope had no data: ${JSON.stringify(res)?.slice(0, 200)}`);
  }
  return envelope.data;
}

/** Text content of the document, in the flat-offset coordinate system that
 *  `tandem_comment` expects — the same one `tandem_getTextContent` returns. */
async function documentText(mcp: McpTestClient, documentId: string): Promise<string> {
  const res = await mcp.callTool("tandem_getTextContent", { documentId });
  return payload<{ text: string }>(res).text;
}

test.describe("v1.0 performance gate", () => {
  test("50-page document: open, annotate, scroll", async ({ page }) => {
    // The perf backend's own pair (#1492) — the helper's default is the E2E pair.
    const mcp = new McpTestClient(`http://127.0.0.1:${PERF_MCP_PORT}/mcp`);
    await mcp.connect();

    try {
      const seedFile = JSON.parse(readFileSync(SEEDS, "utf8")) as {
        requested?: number;
        annotations: AnnotationSeed[];
      };
      const seeds = seedFile.annotations;
      expect(
        seedFile.requested,
        `seed file was generated for a different load than the gate records — ` +
          `regenerate with the generator's DEFAULT_ANNOTATIONS`,
      ).toBe(EXPECTED_ANNOTATION_COUNT);
      expect(
        seeds.length,
        "seed file is short of the load it requested — regenerate the fixture",
      ).toBe(seedFile.requested);

      // Precondition on the interactivity probe: if the fixture ever contains
      // the sentinel, the probe below proves nothing. Checked against the
      // fixture SOURCE, so it survives a re-seed or a reworded word list.
      expect(
        readFileSync(FIXTURE, "utf8"),
        `fixture contains the interactivity sentinel ${INTERACTIVITY_SENTINEL} — ` +
          `pick another, or the open-to-interactive probe is vacuous`,
      ).not.toContain(INTERACTIVITY_SENTINEL);

      // --- Force the measured configuration ---------------------------------
      // Margin view is opt-in and defaults to false
      // (useTandemSettings.ts `DEFAULTS.marginView`), so a fresh Playwright
      // context measures the side panel and nothing else — the exact defect
      // that made run 1's headline attribution wrong. Rail visibility and
      // widths stay at their shipping defaults, so this remains a
      // configuration a user can actually be in.
      // `schemaVersion` must be present or the migration chain rewrites the
      // blob from v1.
      //
      // `primaryTab` must be present TOO, and it is not redundant. A written
      // blob does NOT inherit `DEFAULTS` for its absent keys: `loadSettings`
      // routes it through `normalizeKnownFields`, which clamps field by field,
      // and `primaryTab`'s absent-key branch does not land on `DEFAULTS` —
      // `parsed.primaryTab === "annotations" ? "annotations" : "chat"` reads a
      // MISSING key as `"chat"`, the opposite of `DEFAULTS.primaryTab`. (Real
      // users never hit this: `updateSettings` persists the full merged
      // object, and a blob-less first run returns `DEFAULTS` (with
      // `reduceMotion` resolved) without going through the validator. It bites only a partial blob like this one.) Landing on Chat leaves the
      // Annotations panel `display: none` — PanelSlot toggles visibility with
      // CSS, so its cards stay in the DOM at zero size — and every rail-scoped
      // assertion below would fail on an element that is present and correct.
      await page.addInitScript(
        ([key, blob]) => {
          window.localStorage.setItem(key, blob);
        },
        [
          TANDEM_SETTINGS_KEY,
          JSON.stringify({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            marginView: true,
            primaryTab: "annotations",
          }),
        ] as const,
      );

      // --- Warm the app -----------------------------------------------------
      await mcp.callTool("tandem_open", { filePath: WARMUP_DOC });
      await page.goto("/");
      // #1492: prove the SERVED client targets the perf backend BEFORE any
      // UI-driven step. A stale dist/perf-client baked to the product ports
      // would drive every fetch below into a real Tandem (loopback origin
      // checks admit it) and fail confusingly here instead. This is the
      // client-side twin of the e2e guard's Vite check — `vite preview` has
      // no dev server to interrogate, so the page itself reports its ports
      // via window.__TANDEM_PORTS__ (src/client/utils/backend-ports.ts).
      const servedPorts = await page.evaluate(() => window.__TANDEM_PORTS__);
      expect(
        servedPorts,
        "served client does not target the perf backend — rebuild with `npm run perf:gate` " +
          "(scripts/perf-build.ts bakes dist/perf-client to the perf pair)",
      ).toEqual({ ws: PERF_WS_PORT, mcp: PERF_MCP_PORT });
      await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 60_000 });

      // ======================================================================
      // 1. Open-to-interactive
      // ======================================================================
      // The clock starts at the OPEN ACTION, with the app already interactive —
      // not at navigation. Starting at navigation would fold app-boot cost into a
      // number meant to isolate document-scale cost, inflating it systematically
      // and conflating two unrelated things.
      //
      // Both ends are stamped in THIS process. Never compare a Node
      // `performance.now()` against one minted in the page: different epochs,
      // producing an error of unknown sign.
      const lastHeading = await lastHeadingText();
      const editor = page.locator(".ProseMirror");

      const openStart = Date.now();
      const openRes = await mcp.callTool("tandem_open", { filePath: FIXTURE });
      // Painted through the last heading. (No virtualization exists in the
      // editor, so the whole document mounts — this is effectively "render
      // finished", which is what we want.)
      await expect(editor.getByText(lastHeading, { exact: false }).first()).toBeVisible({
        timeout: 120_000,
      });
      // ...AND actually usable. Painted-but-unresponsive is not interactive.
      await editor.click();
      await page.keyboard.type(INTERACTIVITY_SENTINEL);
      await expect(editor).toContainText(INTERACTIVITY_SENTINEL);
      const openMs = Date.now() - openStart;

      // Undo the probe, and VERIFY it. A partial removal would leave the
      // measured document dirty for the seeding pass, which anchors against
      // its text.
      for (let i = 0; i < INTERACTIVITY_SENTINEL.length; i++) {
        await page.keyboard.press("Backspace");
      }
      await expect(editor).not.toContainText(INTERACTIVITY_SENTINEL);
      report("open-to-interactive", openMs, THRESHOLD_OPEN_MS);

      // Condition 1 is measured with the margin column NOT mounted, and cannot
      // be otherwise: margin sides presence-collapse (`getRightHasPending` →
      // `resolveSideMode`), so with zero annotations in the document the column
      // is absent from the DOM no matter what `marginView` says. Asserted
      // rather than assumed, because it is a premise of the recorded number.
      await expect(page.getByTestId("margin-column-right")).toHaveCount(0);

      const documentId = payload<{ documentId?: string }>(openRes).documentId;
      expect(documentId, "tandem_open returned no documentId").toBeTruthy();

      // ======================================================================
      // 2. Annotation create / accept — under a realistic margin load
      // ======================================================================
      // Seed the margin first, UNTIMED. This is the load, not the measurement:
      // scroll and interaction cost here are dominated by the margin pipeline
      // (resolveCrowding simulates the whole card stack from raw anchor tops).
      // Measuring a create against an empty margin would measure nothing the
      // "~50 pages may be slow" limitation is about.
      //
      // The LAST seed is held back as the measured target: the generator emits
      // seeds in ascending document-position order, so it is the deepest.
      const text = await documentText(mcp, documentId!);
      const loadSeeds = seeds.slice(0, -1);
      const measuredSeed = seeds[seeds.length - 1];

      const missing: string[] = [];
      const ambiguous: string[] = [];
      let created = 0;
      for (const seed of loadSeeds) {
        // Three-way, not two. The generator checks uniqueness against its own
        // whitespace-COLLAPSED projection, while this resolves against
        // `extractText()`, which keeps newlines and prepends heading prefixes —
        // a different projection, so "never occurs here" is a genuinely
        // distinct defect from "occurs twice", and neither may be silently
        // tolerated. `indexOf !== lastIndexOf` alone would pass an absent quote
        // (-1 === -1) straight into `tandem_comment` with `from = -1`.
        const at = text.indexOf(seed.quote);
        if (at < 0) {
          missing.push(seed.quote);
          continue;
        }
        if (at !== text.lastIndexOf(seed.quote)) {
          ambiguous.push(seed.quote);
          continue;
        }
        // Through `payload()`: a raw `callTool` would count an error envelope
        // as a success, because `mcpError` does not set `isError`.
        payload<{ annotationId?: string }>(
          await mcp.callTool("tandem_comment", {
            documentId,
            from: at,
            to: at + seed.quote.length,
            text: seed.text,
          }),
        );
        created++;
      }
      console.log(
        `  seeded ${created}/${loadSeeds.length} annotations ` +
          `(unresolvable: ${missing.length}, ambiguous: ${ambiguous.length})`,
      );
      expect(
        missing,
        "seed quotes that do not occur in the document text — the generator's " +
          "plain-text projection has drifted from extractText()",
      ).toEqual([]);
      expect(ambiguous, "seed quotes that occur more than once — the anchor is arbitrary").toEqual(
        [],
      );
      // Exact, not 90%. With `payload()` rejecting error envelopes and both
      // resolution failures pre-checked, a shortfall is a defect, not tolerance.
      expect(created, "not every seed annotation was created").toBe(loadSeeds.length);

      // NOW the margin column can exist — presence-collapse is satisfied.
      //
      // Checked as ATTACHED + WIDE, never `toBeVisible`. The column element is
      // a pure positioning context: `position: absolute; top: 0` with every
      // bubble inside it also absolutely positioned, so it has NO in-flow
      // content and its border box measures 243 x 0 even in a fully-rendered
      // `full`-mode margin carrying a full card stack (measured, not inferred).
      // Playwright treats an empty bounding box as hidden, so `toBeVisible` on
      // THIS element is unsatisfiable in every configuration — it fails
      // identically whether the margin renders perfectly or not at all, which
      // makes it useless as the premise check it was written to be.
      //
      // The width assertion carries that intent instead, and it is not vacuous:
      // it pins the width ladder at `full`. Rails = 300 (right rail
      // default-visible at PANEL_DEFAULT_WIDTH, left default-hidden), so
      // `marginModeThresholds(300).t1 = 2*272 + 300 + 480 = 1324` and the
      // pinned 1600 viewport lands in `full` with 276px of headroom over the
      // 32px hysteresis band. `full` is the only mode whose column reaches 240
      // (`narrow` 160, `stub` 28), and `narrow` renders `clamped` cards with no
      // action row — which would hang the measured accept click below. A future
      // geometry or viewport change that drops the ladder a rung fails HERE,
      // with the reason, instead of 100 lines later as an opaque timeout.
      const margin = page.getByTestId("margin-column-right");
      await expect(
        margin,
        "margin column did not mount — the seeded load is not being rendered by " +
          "the pipeline this gate exists to measure",
      ).toBeAttached({ timeout: 60_000 });
      const marginWidth = (await margin.boundingBox())?.width ?? 0;
      expect(
        marginWidth,
        `margin column is ${marginWidth}px wide — the width ladder is not in \`full\` ` +
          `(narrow=160, stub=28), so the cards this gate measures are not the ones it ` +
          `records. Check the viewport in playwright.config.ts against ` +
          `marginModeThresholds(railsWidthPx).t1.`,
      ).toBeGreaterThanOrEqual(MARGIN_TRACK_GEOMETRY.full.column);

      // Wait for the margin load to actually RENDER before measuring anything
      // against it. Seeding over MCP only guarantees the server-side writes
      // landed; the whole point of the load is the client-side card stack, so
      // measuring before it exists would measure an empty margin. Counted as
      // margin BUBBLES, which only the margin pipeline produces — an
      // `annotation-card-` count is satisfied by the side panel alone.
      // 90% slack here (unlike the create count) because rendering is
      // asynchronous and genuinely racy, and it is measured against `created`,
      // a number that now means what it says.
      await expect
        .poll(() => page.locator('[data-testid^="margin-bubble-"]').count(), {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(Math.floor(created * 0.9));

      // ...and that a card is actually PAINTED, not merely in the DOM. This is
      // the visibility check the column-level `toBeVisible` above was reaching
      // for: unlike the zero-height column, a bubble is a real box (measured
      // 243 x 168), so `toBeVisible` here is a claim that can fail.
      await expect(
        page.locator('[data-testid^="margin-bubble-"]').first(),
        "margin bubbles are in the DOM but none is rendered with a visible box",
      ).toBeVisible({ timeout: 60_000 });

      // Now the measured one, deep in the document — anchoring cost scales with
      // position, so annotating paragraph 1 would flatter the number. The
      // generator already solved "a unique quote from deep in the document",
      // with stronger rules than a spec-side re-implementation had (it rejects
      // multi-line blocks and checks uniqueness against the whole document), so
      // this uses its last seed rather than re-deriving one.
      const from = text.indexOf(measuredSeed.quote);
      expect(from, "measured annotation target does not occur in the document").toBeGreaterThan(-1);
      expect(text.lastIndexOf(measuredSeed.quote), "measured annotation target is ambiguous").toBe(
        from,
      );
      // Guard the "deepest" claim at runtime. Seed ordering is a generator
      // invariant (it sorts by document position before writing), but the
      // measurement is only comparable run to run if the target really is late
      // in the document, so verify rather than trust.
      expect(
        from,
        "measured annotation target is not deep in the document — seed ordering has drifted",
      ).toBeGreaterThan(text.length * 0.5);

      const createStart = Date.now();
      const createdRes = await mcp.callTool("tandem_comment", {
        documentId,
        from,
        to: from + measuredSeed.quote.length,
        text: "Measured annotation.",
      });
      const annotationId = payload<{ annotationId?: string }>(createdRes).annotationId;
      expect(annotationId, "tandem_comment returned no annotation id").toBeTruthy();

      // The side-panel rail card is the create target, NOT the margin bubble:
      // it is the surface run 1 measured, and the recorded table only stays
      // comparable if run 2 measures the same element. The rail is ALWAYS
      // mounted (`.rail-full` merely display:none's when collapsed), so it
      // exists regardless of rail visibility.
      const rail = page.locator(".rail-full-right");
      await expect(rail.getByTestId(`annotation-card-${annotationId}`)).toBeVisible({
        timeout: 30_000,
      });
      const createMs = Date.now() - createStart;
      report("annotation-create", createMs, THRESHOLD_ANNOTATION_MS);

      // The double-count regression pin. With the margin mounted the bare
      // per-annotation testid matches TWICE — once in the rail, once in the
      // margin column — which is why every locator below is scoped. Asserting
      // the count is stronger than either scoping alone: it fails loudly if a
      // future change silently drops one surface.
      await expect(
        page.getByTestId(`accept-btn-${annotationId}`),
        "expected the accept control in BOTH the rail and the margin column",
      ).toHaveCount(2, { timeout: 30_000 });

      const acceptStart = Date.now();
      // Split the click from the settle. Playwright's click waits for the
      // element to be stable (same box across consecutive frames) — with a
      // loaded margin column that can itself take seconds, which is a completely
      // different defect from a slow accept handler. Reporting one number would
      // not distinguish them. #1288 is that wait.
      //
      // Measured on the RAIL button, deliberately: that is where run 1's
      // 7851ms time-to-clickable was observed, and measuring the margin button
      // instead would leave the one reproducible defect this gate found
      // unmeasured while reporting a number with no prior to compare it to.
      // The margin column is mounted and loaded either way, so its cost is in
      // the number.
      await rail.getByTestId(`accept-btn-${annotationId}`).click();
      const clickMs = Date.now() - acceptStart;
      // Measure to the accept being REFLECTED, which is the disappearance of the
      // accept control — the card itself may persist in a resolved state, so
      // waiting on the card to vanish would either never settle or measure
      // something else entirely. In the margin column the whole bubble leaves
      // once the annotation is no longer `pending`, so counting the accept
      // control to zero ACROSS BOTH surfaces is still exactly "the accept was
      // reflected".
      // `toHaveCount` retries on a tight fixed cadence. `expect.poll` backs off
      // (100/250/500/1000ms...), which would inflate a multi-second reading by
      // up to a whole interval and make the instrument part of the number.
      await expect(page.getByTestId(`accept-btn-${annotationId}`)).toHaveCount(0, {
        timeout: 30_000,
      });
      const acceptMs = Date.now() - acceptStart;
      console.log(
        `  accept breakdown: click-dispatch ${clickMs}ms, post-click settle ${acceptMs - clickMs}ms`,
      );
      report("annotation-accept", acceptMs, THRESHOLD_ANNOTATION_MS);

      // ======================================================================
      // 3. Frame stalls during a scripted top-to-bottom scroll
      // ======================================================================
      // rAF-delta is the GROUND TRUTH for "was a frame dropped". The longtask
      // observer is DIAGNOSTIC ONLY: it sees main-thread script tasks >=50ms and
      // structurally cannot see compositor or raster stalls — which is precisely
      // where this codebase lives, given its backdrop-filter surfaces
      // (#798/#1189) and the motion language. A clean longtask reading alone must
      // never be read as clearing this condition.
      const scroll = await measureScroll(page);

      console.log(
        `  scroll: ${scroll.frames} frames, worst gap ${scroll.maxFrameGapMs.toFixed(1)}ms, ` +
          `longtasks>50ms: ${scroll.longTasks} (worst ${scroll.maxLongTaskMs.toFixed(1)}ms)`,
      );
      console.log(
        `  scroll distance: ${scroll.scrolledPx}px of ${scroll.scrollableStart}px scrollable`,
      );
      report("worst-frame-gap", scroll.maxFrameGapMs, THRESHOLD_FRAME_STALL_MS);

      console.log("\n  --- summary ---");
      console.log(`  ${JSON.stringify(results)}`);

      // Assertions last, so every number is printed even when one condition fails.
      //
      // The scroll-integrity assertions belong here too: a scroll that never
      // moved reports a worst gap of NaN (see measureScroll), which reads as a
      // FAIL rather than a spurious 0.0ms pass, but the reason only becomes
      // legible from the distance numbers above.
      expect(scroll.scrollableStart, "document was not scrollable at all").toBeGreaterThan(0);
      expect(
        scroll.scrolledPx,
        "the scripted scroll did not reach the bottom — condition 3 measures a scroll " +
          "that must actually happen",
      ).toBeGreaterThanOrEqual(scroll.scrollableStart * 0.9);
      expect(
        scroll.frames,
        "too few frames sampled to characterise a scroll",
      ).toBeGreaterThanOrEqual(30);

      expect(openMs, "open-to-interactive exceeded 3s").toBeLessThanOrEqual(THRESHOLD_OPEN_MS);
      expect(createMs, "annotation create exceeded 500ms").toBeLessThanOrEqual(
        THRESHOLD_ANNOTATION_MS,
      );
      expect(acceptMs, "annotation accept exceeded 500ms").toBeLessThanOrEqual(
        THRESHOLD_ANNOTATION_MS,
      );
      expect(scroll.maxFrameGapMs, "a frame gap exceeded 100ms during scroll").toBeLessThanOrEqual(
        THRESHOLD_FRAME_STALL_MS,
      );
    } finally {
      // Every assertion above is a way to exit early; a leaked transport per
      // failed run is what an operator iterating on the harness accumulates.
      await mcp.close();
    }
  });
});

/** Last `## ` heading in the fixture — the paint target for condition 1. */
async function lastHeadingText(): Promise<string> {
  const md = readFileSync(FIXTURE, "utf8");
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  if (headings.length === 0) throw new Error("fixture has no h2 headings");
  return headings[headings.length - 1];
}

interface ScrollMeasurement {
  frames: number;
  maxFrameGapMs: number;
  longTasks: number;
  maxLongTaskMs: number;
  /** How far the scroll actually travelled, px. */
  scrolledPx: number;
  /** How far it COULD have travelled when it started, px. */
  scrollableStart: number;
}

/**
 * Continuous top-to-bottom scroll with per-frame timing.
 *
 * Runs entirely in the page so the rAF timestamps come from one clock, and
 * returns aggregates rather than raw samples.
 *
 * The scroll is driven a fixed delta PER FRAME, from inside the same rAF
 * callback that records the gaps. The earlier shape — jump 0.8 of a viewport,
 * then `setTimeout(100)` — had two problems: no input device produces a
 * 0.8-viewport discontinuity, and the 100ms of idle between jumps let every
 * deferred subsystem drain, so the recorded gaps were of an editor at rest.
 * Per-frame delta is roughly trackpad momentum, keeps the rAF-throttled margin
 * position recompute in its real duty cycle, and makes the travelled distance
 * exact.
 */
async function measureScroll(page: Page): Promise<ScrollMeasurement> {
  return await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-testid="editor-scroll-container"]');
    if (!el) throw new Error("editor scroll container not found");

    let maxLongTaskMs = 0;
    let longTasks = 0;
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks++;
          maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks API unavailable — diagnostic only, so proceed. rAF-delta
      // is what actually decides this condition.
    }

    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 250));
    const scrollableStart = el.scrollHeight - el.clientHeight;

    /** ~60px/frame ≈ trackpad momentum at 60Hz. */
    const PER_FRAME_PX = 60;
    const gaps: number[] = [];

    await new Promise<void>((resolve) => {
      // The first gap after an idle period reflects scheduling, not rendering,
      // so the first tick only establishes the baseline timestamp.
      let last = 0;
      let stalledFrames = 0;
      const tick = (now: number) => {
        if (last !== 0) gaps.push(now - last);
        last = now;

        const before = el.scrollTop;
        el.scrollTop = before + PER_FRAME_PX;
        if (el.scrollTop === before) {
          // Bottom reached (or the container refuses to move). Allow a couple
          // of frames of grace so a single dropped update is not read as the
          // end.
          if (++stalledFrames >= 3) {
            resolve();
            return;
          }
        } else {
          stalledFrames = 0;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const scrolledPx = el.scrollTop;
    await new Promise((r) => setTimeout(r, 100));
    observer?.disconnect();

    return {
      frames: gaps.length,
      // NaN, not 0, for an empty sample: `NaN <= threshold` is false, so a
      // scroll that never happened reports FAIL instead of a perfect 0.0ms.
      maxFrameGapMs: gaps.length ? Math.max(...gaps) : Number.NaN,
      longTasks,
      maxLongTaskMs,
      scrolledPx,
      scrollableStart,
    };
  });
}
