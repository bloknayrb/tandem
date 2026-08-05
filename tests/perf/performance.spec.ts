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

/** Text content of the document, in the flat-offset coordinate system that
 *  `tandem_comment` expects — the same one `tandem_getTextContent` returns. */
async function documentText(mcp: McpTestClient, documentId: string): Promise<string> {
  const res = (await mcp.callTool("tandem_getTextContent", { documentId })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("tandem_getTextContent returned no text");
  return text;
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
    const openRes = (await mcp.callTool("tandem_open", { filePath: FIXTURE })) as {
      structuredContent?: { documentId?: string };
    };
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

    const documentId = openRes.structuredContent?.documentId;
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

    await expect(
      page.getByTestId("status-ai-indicator").or(page.locator(".ProseMirror")),
    ).toBeVisible();

    // Now the measured one, deep in the document — anchoring cost scales with
    // position, so annotating paragraph 1 would flatter the number.
    const tail = text.slice(Math.floor(text.length * 0.85));
    const target = tail.split(/\s+/).slice(4, 12).join(" ");
    const from = text.indexOf(target, Math.floor(text.length * 0.85));
    expect(from, "could not locate a deep-document annotation target").toBeGreaterThan(0);

    const createStart = Date.now();
    const created = (await mcp.callTool("tandem_comment", {
      documentId,
      from,
      to: from + target.length,
      text: "Measured annotation.",
    })) as { structuredContent?: { annotationId?: string; id?: string } };
    const annotationId = created.structuredContent?.annotationId ?? created.structuredContent?.id;
    expect(annotationId, "tandem_comment returned no annotation id").toBeTruthy();

    const card = page.getByTestId(`annotation-card-${annotationId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const createMs = Date.now() - createStart;
    report("annotation-create", createMs, THRESHOLD_ANNOTATION_MS);

    const acceptStart = Date.now();
    await card.getByTestId("accept-btn").click();
    await expect(card).toBeHidden({ timeout: 30_000 });
    const acceptMs = Date.now() - acceptStart;
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
