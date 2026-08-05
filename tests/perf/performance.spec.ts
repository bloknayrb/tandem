import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
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
    const mcp = new McpTestClient();
    await mcp.connect();

    const seeds: AnnotationSeed[] = JSON.parse(readFileSync(SEEDS, "utf8")).annotations;
    expect(seeds.length, "fixture annotation seed is empty — regenerate it").toBeGreaterThan(0);

    // --- Warm the app -------------------------------------------------------
    await mcp.callTool("tandem_open", { filePath: WARMUP_DOC });
    await page.goto("/");
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 60_000 });

    // ========================================================================
    // 1. Open-to-interactive
    // ========================================================================
    // The clock starts at the OPEN ACTION, with the app already interactive —
    // not at navigation. Starting at navigation would fold app-boot cost into a
    // number meant to isolate document-scale cost, inflating it systematically
    // and conflating two unrelated things.
    //
    // Both ends are stamped in THIS process. Never compare a Node
    // `performance.now()` against one minted in the page: different epochs,
    // producing an error of unknown sign.
    const lastHeading = await lastHeadingText();

    const openStart = Date.now();
    const openRes = await mcp.callTool("tandem_open", { filePath: FIXTURE });
    // Painted through the last heading. (No virtualization exists in the
    // editor, so the whole document mounts — this is effectively "render
    // finished", which is what we want.)
    await expect(
      page.locator(".ProseMirror").getByText(lastHeading, { exact: false }).first(),
    ).toBeVisible({ timeout: 120_000 });
    // ...AND actually usable. Painted-but-unresponsive is not interactive.
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("x");
    await expect(page.locator(".ProseMirror")).toContainText("x");
    const openMs = Date.now() - openStart;

    await page.keyboard.press("Backspace");
    report("open-to-interactive", openMs, THRESHOLD_OPEN_MS);

    const documentId = payload<{ documentId?: string }>(openRes).documentId;
    expect(documentId, "tandem_open returned no documentId").toBeTruthy();

    // ========================================================================
    // 2. Annotation create / accept — under a realistic margin load
    // ========================================================================
    // Seed the margin first, UNTIMED. This is the load, not the measurement:
    // scroll and interaction cost here are dominated by the margin pipeline
    // (resolveCrowding simulates the whole card stack from raw anchor tops).
    // Measuring a create against an empty margin would measure nothing the
    // "~50 pages may be slow" limitation is about.
    const text = await documentText(mcp, documentId!);
    let seeded = 0;
    for (const seed of seeds) {
      const from = text.indexOf(seed.quote);
      if (from < 0) continue; // reported below — a silent shortfall would understate the load
      await mcp.callTool("tandem_comment", {
        documentId,
        from,
        to: from + seed.quote.length,
        text: seed.text,
      });
      seeded++;
    }
    console.log(`  seeded ${seeded}/${seeds.length} annotations`);
    expect(
      seeded,
      "fewer than 90% of seeded annotations anchored — the margin load is not what the gate assumes",
    ).toBeGreaterThanOrEqual(Math.floor(seeds.length * 0.9));

    // Wait for the margin load to actually RENDER before measuring anything
    // against it. Seeding over MCP only guarantees the server-side writes
    // landed; the whole point of the load is the client-side card stack, so
    // measuring before it exists would measure an empty margin.
    await expect
      .poll(() => page.locator('[data-testid^="annotation-card-"]').count(), {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(Math.floor(seeded * 0.9));

    // Now the measured one, deep in the document — anchoring cost scales with
    // position, so annotating paragraph 1 would flatter the number.
    // Take the slice from a real LINE of the document text, never by
    // re-joining split words: the join would insert a space where the original
    // had a newline, and the resulting string exists nowhere in the document.
    const target = deepUniqueQuote(text);
    const from = text.indexOf(target);
    expect(from, "could not locate a deep-document annotation target").toBeGreaterThan(0);

    const createStart = Date.now();
    const created = await mcp.callTool("tandem_comment", {
      documentId,
      from,
      to: from + target.length,
      text: "Measured annotation.",
    });
    const annotationId = payload<{ annotationId?: string }>(created).annotationId;
    expect(annotationId, "tandem_comment returned no annotation id").toBeTruthy();

    // `.first()` is required, not defensive: an annotation renders in BOTH the
    // side panel and the margin column, so the bare testid matches two
    // elements and a strict-mode locator throws.
    const card = page.getByTestId(`annotation-card-${annotationId}`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const createMs = Date.now() - createStart;
    report("annotation-create", createMs, THRESHOLD_ANNOTATION_MS);

    const acceptStart = Date.now();
    // Split the click from the settle. Playwright's click waits for the
    // element to be stable (same box across consecutive frames) — with a
    // loaded margin column that can itself take seconds, which is a completely
    // different defect from a slow accept handler. Reporting one number would
    // not distinguish them.
    // Note: the testid is per-annotation (`accept-btn-{id}`), not the bare
    // `accept-btn` that CLAUDE.md's selector list still records.
    await page.getByTestId(`accept-btn-${annotationId}`).first().click();
    const clickMs = Date.now() - acceptStart;
    // Measure to the accept being REFLECTED, which is the disappearance of the
    // accept control — the card itself may persist in a resolved state, so
    // waiting on the card to vanish would either never settle or measure
    // something else entirely.
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

    // ========================================================================
    // 3. Frame stalls during a scripted top-to-bottom scroll
    // ========================================================================
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
    report("worst-frame-gap", scroll.maxFrameGapMs, THRESHOLD_FRAME_STALL_MS);

    console.log("\n  --- summary ---");
    console.log(`  ${JSON.stringify(results)}`);

    await mcp.close?.();

    // Assertions last, so every number is printed even when one condition fails.
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
  });
});

/**
 * A uniquely-occurring 40-char quote from late in the document.
 *
 * Walks backwards over real lines of the document text so the slice is
 * guaranteed to exist verbatim, and requires uniqueness so the anchor is not
 * ambiguous. Deep in the document on purpose: anchoring cost scales with
 * position, so measuring a create against paragraph one would flatter it.
 */
function deepUniqueQuote(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= Math.floor(lines.length * 0.5); i--) {
    const line = lines[i];
    if (line.length < 120) continue;
    if (/^(#|\||```|-|\d+\.)/.test(line.trim())) continue;
    const candidate = line.slice(20, 60);
    if (text.indexOf(candidate) === text.lastIndexOf(candidate)) return candidate;
  }
  throw new Error("no unique deep-document quote found in fixture");
}

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
}

/**
 * Scripted top-to-bottom scroll with per-frame timing.
 *
 * Runs entirely in the page so the rAF timestamps come from one clock, and
 * returns aggregates rather than raw samples.
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

    const gaps: number[] = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 250));
    // Discard warm-up frames: the first rAF gap after an idle period reflects
    // scheduling, not rendering.
    gaps.length = 0;
    last = performance.now();

    const step = Math.max(200, Math.floor(el.clientHeight * 0.8));
    while (el.scrollTop + el.clientHeight < el.scrollHeight) {
      const before = el.scrollTop;
      el.scrollTop = before + step;
      if (el.scrollTop === before) break; // hit the end
      await new Promise((r) => setTimeout(r, 100));
    }

    running = false;
    await new Promise((r) => setTimeout(r, 100));
    observer?.disconnect();

    return {
      frames: gaps.length,
      maxFrameGapMs: gaps.length ? Math.max(...gaps) : 0,
      longTasks,
      maxLongTaskMs,
    };
  });
}
