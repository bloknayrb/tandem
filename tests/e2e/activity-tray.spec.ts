import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Activity center (sub-PR 1.10a): the bottom-right pill + expandable tray, fed
// by the same notification store as the transient toast pops. Notifications are
// injected via the dev-only `__tandemTest.pushNotification` hook to avoid the
// SSE-connect race (the server notify-stream has no buffer replay, so a
// notification pushed before the EventSource connects would be lost). This
// drives the real client `push` → ingest path, identical to production echoes.

let mcp: McpTestClient;
let tmpDir: string;

interface InjectableNotification {
  id: string;
  type: string;
  severity: "info" | "warning" | "error";
  message: string;
  dedupKey?: string;
  documentId?: string;
}

async function pushNotification(page: Page, n: InjectableNotification): Promise<void> {
  await page.evaluate((notification) => {
    const w = window as unknown as {
      __tandemTest?: { pushNotification: (x: unknown) => void };
    };
    if (!w.__tandemTest?.pushNotification) {
      throw new Error(
        "__tandemTest.pushNotification is not installed — App.svelte must export it in dev builds",
      );
    }
    w.__tandemTest.pushNotification({ ...notification, timestamp: Date.now() });
  }, n);
}

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

async function openEditor(page: Page): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
}

test("pill shows the empty state and toggles the tray open and closed", async ({ page }) => {
  await openEditor(page);

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("No activity");
  await expect(pill).toHaveAttribute("aria-expanded", "false");

  // Tray is not mounted until opened.
  await expect(page.locator("[data-testid='activity-tray']")).toHaveCount(0);

  await pill.click();
  await expect(page.locator("[data-testid='activity-tray']")).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-testid='activity-empty']")).toContainText("Nothing to report.");

  await pill.click();
  await expect(page.locator("[data-testid='activity-tray']")).toHaveCount(0);
  await expect(pill).toHaveAttribute("aria-expanded", "false");
});

test("warning notification pops a transient toast AND lands in the tray", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "warn-1",
    type: "annotation-error",
    severity: "warning",
    message: "Your AI tried a deprecated tool.",
  });

  // Transient pop appears.
  const toast = page.locator("[data-testid='toast-warn-1']");
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText("Your AI tried a deprecated tool.");

  // Pill reflects the count; tray row carries the same message.
  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("1");
  await pill.click();
  await expect(page.locator("[data-testid='activity-row-warn-1']")).toContainText(
    "Your AI tried a deprecated tool.",
  );
});

test("dismissing the pop leaves the tray entry; dismissing the row removes it", async ({
  page,
}) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "err-1",
    type: "general-error",
    severity: "error",
    message: "Something went wrong.",
  });

  const toast = page.locator("[data-testid='toast-err-1']");
  await expect(toast).toBeVisible({ timeout: 5_000 });

  // Dismiss the transient pop — the tray entry must survive.
  await page.locator("[data-testid='toast-dismiss-err-1']").click();
  await expect(toast).toHaveCount(0);

  const pill = page.locator("[data-testid='activity-pill']");
  await pill.click();
  const row = page.locator("[data-testid='activity-row-err-1']");
  await expect(row).toBeVisible();

  // Dismiss the tray row — now it is gone and the pill is empty.
  await page.locator("[data-testid='activity-dismiss-err-1']").click();
  await expect(row).toHaveCount(0);
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
});

test("Clear all empties the tray", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "e1",
    type: "general-error",
    severity: "error",
    message: "First error.",
  });
  await pushNotification(page, {
    id: "e2",
    type: "general-error",
    severity: "error",
    message: "Second error.",
  });

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("2");
  await pill.click();

  await expect(page.locator("[data-testid='activity-row-e1']")).toBeVisible();
  await expect(page.locator("[data-testid='activity-row-e2']")).toBeVisible();

  await page.locator("[data-testid='activity-clear-all']").click();
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
  await expect(pill).toContainText("No activity");
});

test("activity persists across a page reload", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "persist-1",
    type: "general-error",
    severity: "error",
    message: "Survives reload.",
  });

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("1");

  // The localStorage write is debounced (250ms); a hard reload tears down the
  // JS context without a graceful unmount, so poll until the entry is durable
  // before reloading rather than racing the debounce.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tandem:activityHistory") ?? ""))
    .toContain("persist-1");

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Rehydrated from localStorage — error severity is not TTL-pruned.
  await expect(page.locator("[data-testid='activity-pill']")).toContainText("1");
  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator("[data-testid='activity-row-persist-1']")).toContainText(
    "Survives reload.",
  );
});

test("a save-error row shows Retry, and clicking it re-runs the save for that doc", async ({
  page,
}) => {
  await openEditor(page);

  // Intercept the save POST so no real disk write happens, and capture the
  // documentId the Retry button forwards to triggerSave.
  let savedDocumentId: string | null = null;
  await page.route("**/api/save", async (route) => {
    if (route.request().method() === "POST") {
      savedDocumentId =
        (route.request().postDataJSON() as { documentId?: string }).documentId ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "saved" }),
      });
    } else {
      await route.continue();
    }
  });

  // Target the genuinely-open active doc so onAction reaches triggerSave
  // (rather than the closed-doc "reopen to retry" fallback).
  const docId = await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { activeDocumentId: () => string | null } };
    return w.__tandemTest?.activeDocumentId() ?? null;
  });
  expect(docId).toBeTruthy();

  await pushNotification(page, {
    id: "save-err-1",
    type: "save-error",
    severity: "error",
    message: "Save failed: disk full",
    documentId: docId as string,
  });

  await page.locator("[data-testid='activity-pill']").click();
  const retry = page.locator("[data-testid='activity-action-save-err-1']");
  await expect(retry).toBeVisible();
  await expect(retry).toContainText("Retry");

  await retry.click();
  await expect.poll(() => savedDocumentId).toBe(docId);
});

// A14 row lifecycle (#798 Phase 4). These two are a MATCHED PAIR and only mean
// something together: the reduced-motion case asserts the row is gone almost
// immediately, which passes trivially whether or not an exit animation exists —
// `toHaveCount(0)` auto-retries, so a bare version of it is green forever. The
// motion-on case is what gives it teeth: it proves the row genuinely lingers past
// the store write, so "gone within 100ms" is a real discriminator rather than a
// tautology. Both drive the in-app `reduceMotion` setting rather than Playwright's
// `reducedMotion` context option, because `motionOff()` reads `matchMedia` and the
// suite disagrees with itself about whether that option reliably drives it
// (annotation-ping.spec.ts:19 vs redesign-final-qa.spec.ts:180).

async function setReduceMotion(page: Page, value: boolean): Promise<void> {
  await page.addInitScript((reduce) => {
    const KEY = "tandem:settings";
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      existing = {};
    }
    localStorage.setItem(KEY, JSON.stringify({ ...existing, reduceMotion: reduce }));
  }, value);
}

test("a dismissed row lingers for its exit animation when motion is on", async ({ page }) => {
  await setReduceMotion(page, false);
  await openEditor(page);

  await pushNotification(page, {
    id: "m1",
    type: "general-error",
    severity: "error",
    message: "Motion on.",
  });
  await page.locator("[data-testid='activity-pill']").click();
  const row = page.locator("[data-testid='activity-row-m1']");
  await expect(row).toBeVisible();

  await page.locator("[data-testid='activity-dismiss-m1']").click();
  // Still in the DOM immediately after the click: the store dropped it, but the
  // `out:rowOut` outro is holding the node. This is the assertion that would fail
  // if the exit were wired as a plain removal.
  await expect(row).toHaveCount(1, { timeout: 60 });
  // ...and it does eventually leave, so the node is not stranded.
  await expect(row).toHaveCount(0);
});

test("a dismissed row is removed immediately under reduced motion", async ({ page }) => {
  await setReduceMotion(page, true);
  await openEditor(page);
  await expect(page.locator("body.tandem-reduce-motion")).toHaveCount(1);

  await pushNotification(page, {
    id: "m2",
    type: "general-error",
    severity: "error",
    message: "Motion off.",
  });
  await page.locator("[data-testid='activity-pill']").click();
  const row = page.locator("[data-testid='activity-row-m2']");
  await expect(row).toBeVisible();

  await page.locator("[data-testid='activity-dismiss-m2']").click();
  // Bounded: `motionOff()` must short-circuit rowOut to {duration:0}, so the node
  // goes on the same tick rather than after the 200ms outro.
  await expect(row).toHaveCount(0, { timeout: 100 });
});

test("the cascade keyframe is suppressed under reduced motion", async ({ page }) => {
  await setReduceMotion(page, true);
  await openEditor(page);

  await pushNotification(page, {
    id: "m3",
    type: "general-error",
    severity: "error",
    message: "Cascade check.",
  });
  // A23's cascade is a CSS @keyframes on `.cascade-row`, which the JS `motionOff()`
  // gate does NOT cover — it needs its own guard. That guard's selector had to move
  // when the cascade was re-anchored off `:nth-child`, so pin it here: a renamed
  // selector orphaning the guard is silent otherwise.
  //
  // The click AND the read both happen inside one `page.evaluate`. `.cascade-row`
  // exists only for the 1800ms cascade window, so any Node-side round-trip (locator
  // click, waitFor, then evaluate) is a race a slow machine loses — this test failed
  // that way twice on cold starts before being written this way.
  const state = await page.evaluate(async () => {
    document.querySelector<HTMLElement>("[data-testid='activity-pill']")?.click();
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline) {
      const el = document.querySelector<HTMLElement>("[data-testid='activity-row-m3']");
      if (el?.classList.contains("cascade-row")) {
        return { cascading: true, animation: getComputedStyle(el).animationName };
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const el = document.querySelector<HTMLElement>("[data-testid='activity-row-m3']");
    return {
      cascading: false,
      animation: el ? getComputedStyle(el).animationName : "<row never rendered>",
    };
  });
  expect(state.cascading).toBe(true);
  expect(state.animation).toBe("none");
});

// The three remaining paths that were regressions before A14. Each one only
// animates because `.tray-list` is now rendered unconditionally instead of living
// in the `{:else}` of the empty state: a plain Svelte `out:` is LOCAL, so tearing
// down an ancestor block skips it, and a local `in:` is skipped while its nearest
// block ancestor is still initializing. Dismissing the LAST row is the fourth path
// and is already covered above — `m1` is the only row in that test.

test("the first event into an open, empty tray unfolds instead of appearing", async ({ page }) => {
  await openEditor(page);

  // Open the tray while it holds nothing, so the empty state is showing.
  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();

  await pushNotification(page, {
    id: "m4",
    type: "general-error",
    severity: "error",
    message: "First arrival.",
  });

  const row = page.locator("[data-testid='activity-row-m4']");
  await expect(row).toBeVisible();
  // No cascade class: the cascade snapshot is taken on the open edge, and this row
  // did not exist then. So it takes `in:rowEnter` — which is the point. Were it
  // tagged, the CSS keyframe and the WAAPI transition would both drive
  // opacity/transform on one element.
  await expect(row).not.toHaveClass(/cascade-row/);
  await expect(page.locator("[data-testid='activity-empty']")).toHaveCount(0);
});

test("clear all holds every row through its exit before the empty state unfolds", async ({
  page,
}) => {
  await openEditor(page);

  for (const id of ["c1", "c2", "c3"]) {
    await pushNotification(page, {
      id,
      type: "general-error",
      severity: "error",
      message: `Row ${id}.`,
    });
  }
  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator("[data-testid='activity-row-c3']")).toBeVisible();

  await page.locator("[data-testid='activity-clear-all']").click();
  // The store is empty on the same tick, but all three nodes are held by their
  // outros. Before A14 this branch-swapped and every row vanished at once.
  await expect(page.locator(".toast-row")).toHaveCount(3, { timeout: 60 });
  // ...and they do all leave, with the empty state arriving after them.
  await expect(page.locator(".toast-row")).toHaveCount(0);
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
});

test("a row arriving mid-cascade is excluded from the cascade", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "b1",
    type: "general-error",
    severity: "error",
    message: "Backlog row.",
  });

  // Open, push, AND sample all inside one browser turn. The cascade class exists
  // only for the 1800ms window, so asserting it from the Node side is a race — and
  // one that fails DECEPTIVELY: once the window closes no row carries the class, so
  // the negative half ("b2 is not cascading") goes green for entirely the wrong
  // reason. Both rows must come from the same sample for the contrast to mean
  // anything. An earlier version of this test asserted them separately and did
  // exactly that.
  const seen = await page.evaluate(async () => {
    const w = window as unknown as {
      __tandemTest?: { pushNotification: (x: unknown) => void };
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const has = (id: string) =>
      document
        .querySelector<HTMLElement>(`[data-testid='activity-row-${id}']`)
        ?.classList.contains("cascade-row") ?? null;

    document.querySelector<HTMLElement>("[data-testid='activity-pill']")?.click();
    // Let the open edge flush FIRST. Pushing in the same synchronous turn batches
    // both mutations into one flush, so the arrival is legitimately present when
    // the snapshot is taken — it would cascade, and correctly so. The regression
    // this guards is the row that arrives AFTER the tray is open, with the window
    // still running, which is the only way it happens outside a test.
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline && !has("b1")) await frame();

    w.__tandemTest?.pushNotification({
      id: "b2",
      type: "general-error",
      severity: "error",
      message: "Mid-cascade arrival.",
      timestamp: Date.now(),
    });
    while (
      performance.now() < deadline &&
      !document.querySelector("[data-testid='activity-row-b2']")
    ) {
      await frame();
    }
    return { b1: has("b1"), b2: has("b2") };
  });

  // The backlog row is in the snapshot and cascades; the new one is not, so it
  // gets `rowEnter` immediately. Under `:nth-child` this row would have inherited
  // a sibling's delay of up to 1090ms and sat at opacity:0 (`both` fill) for over
  // a second before appearing.
  expect(seen.b1).toBe(true);
  expect(seen.b2).toBe(false);
});

test("a coalesced row remounts its count badge so the pop can replay", async ({ page }) => {
  await openEditor(page);

  const repeat = (n: number) =>
    pushNotification(page, {
      id: `k${n}`,
      type: "general-error",
      severity: "error",
      message: "Same thing again.",
      dedupKey: "same-thing",
    });

  await repeat(1);
  await repeat(2);
  await page.locator("[data-testid='activity-pill']").click();

  // Coalescing keeps the FIRST id, so the row stays `k1` and its slot never moves.
  const badge = page.locator("[data-testid='activity-row-k1'] .badge");
  await expect(badge).toHaveText("×2");

  // Tag the current badge node. If the `{#key item.count}` block is removed, the
  // 2→3 increment becomes a plain text swap on this same node and the marker
  // survives — which is exactly the silent regression this pins, because the pop
  // keyframe cannot re-fire without a remount.
  await badge.evaluate((el) => el.setAttribute("data-probe", "gen2"));
  await repeat(3);

  await expect(badge).toHaveText("×3");
  await expect(badge).not.toHaveAttribute("data-probe", "gen2");
});

test("closing and reopening the tray does NOT replay the badge pop without a new coalesce", async ({
  page,
}) => {
  await openEditor(page);

  const repeat = (n: number) =>
    pushNotification(page, {
      id: `p${n}`,
      type: "general-error",
      severity: "error",
      message: "Same thing again.",
      dedupKey: "pop-gate-thing",
    });

  const pill = page.locator("[data-testid='activity-pill']");
  const badge = page.locator("[data-testid='activity-row-p1'] .badge");
  const animationName = () => badge.evaluate((el) => getComputedStyle(el).animationName);

  await repeat(1);
  await repeat(2);
  await pill.click();

  // Genuine first sighting of count 2: the badge pops.
  await expect(badge).toHaveText("×2");
  await expect.poll(animationName).toBe("badgePop");

  // Close the tray (`.tray-inner` unmounts) and reopen it with nothing new
  // having happened. The badge remounts (fresh DOM node — same mechanism the
  // prior test pins), but must NOT replay the pop: it's not a genuine
  // increment, just the user looking again.
  await pill.click();
  await expect(page.locator("[data-testid='activity-tray']")).toHaveCount(0);
  await pill.click();

  await expect(badge).toHaveText("×2");
  await expect.poll(animationName).toBe("none");

  // A genuine new coalesce while the tray stays open still pops normally.
  await repeat(3);
  await expect(badge).toHaveText("×3");
  await expect.poll(animationName).toBe("badgePop");
});

test("rows render newest-first", async ({ page }) => {
  await openEditor(page);

  // The store APPENDS; `rows` reverses at the render boundary. Nothing else in
  // this suite asserts relative order, so dropping the `.reverse()` — or
  // double-reversing it — would otherwise ship silently. The cascade's
  // `--slide-y` indexing reads the same `rows`, so this also guards the cascade
  // running upside-down.
  await pushNotification(page, {
    id: "o1",
    type: "general-error",
    severity: "error",
    message: "Oldest.",
  });
  await pushNotification(page, {
    id: "o2",
    type: "general-error",
    severity: "error",
    message: "Newest.",
  });

  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator(".toast-row .msg")).toHaveText(["Newest.", "Oldest."]);
});

test("an arriving row actually animates in, and does not under reduced motion", async ({
  page,
}) => {
  // `toBeVisible()` cannot tell an instant mount from an animated one — Playwright
  // treats opacity:0 as visible — so without this, deleting `in:rowEnter` (or
  // misspelling the `reduceMotion` prop) would not fail a single test. Sample the
  // computed opacity across the first frames and keep the minimum.
  const minOpacityOnArrival = async () =>
    page.evaluate(async () => {
      const w = window as unknown as {
        __tandemTest?: { pushNotification: (x: unknown) => void };
      };
      w.__tandemTest?.pushNotification({
        id: "a1",
        type: "general-error",
        severity: "error",
        message: "Arriving.",
        timestamp: Date.now(),
      });
      let min = 1;
      const deadline = performance.now() + 150;
      while (performance.now() < deadline) {
        const el = document.querySelector<HTMLElement>("[data-testid='activity-row-a1']");
        if (el) min = Math.min(min, Number(getComputedStyle(el).opacity));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return min;
    });

  await setReduceMotion(page, false);
  await openEditor(page);
  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
  // rowEnter ramps opacity 0→1 over 240ms, so an early frame must catch it partway.
  expect(await minOpacityOnArrival()).toBeLessThan(0.9);

  // Same push under reduced motion: motionOff() short-circuits to {duration: 0},
  // so the row is fully opaque from its first frame. This is the control that
  // makes the assertion above mean "the transition ran" rather than "opacity
  // happened to be low".
  const reduced = await page.context().newPage();
  await setReduceMotion(reduced, true);
  await reduced.goto("/");
  await expect(reduced.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
  await reduced.locator("[data-testid='activity-pill']").click();
  const reducedMin = await reduced.evaluate(async () => {
    const w = window as unknown as {
      __tandemTest?: { pushNotification: (x: unknown) => void };
    };
    w.__tandemTest?.pushNotification({
      id: "a1",
      type: "general-error",
      severity: "error",
      message: "Arriving.",
      timestamp: Date.now(),
    });
    let min = 1;
    const deadline = performance.now() + 150;
    while (performance.now() < deadline) {
      const el = document.querySelector<HTMLElement>("[data-testid='activity-row-a1']");
      if (el) min = Math.min(min, Number(getComputedStyle(el).opacity));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return min;
  });
  expect(reducedMin).toBe(1);
  await reduced.close();
});

test("the transient toast honours reduced motion", async ({ page }) => {
  // ToastContainer had NO reduced-motion guard of any kind before this change —
  // its only @media was `forced-colors`. A fix with no regression test is exactly
  // what the rest of this suite is careful about.
  await setReduceMotion(page, true);
  await openEditor(page);

  await pushNotification(page, {
    id: "t1",
    type: "general-error",
    severity: "error",
    message: "Toast under reduced motion.",
  });

  const card = page.locator("[data-testid='toast-t1']");
  await expect(card).toBeVisible({ timeout: 5_000 });
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
