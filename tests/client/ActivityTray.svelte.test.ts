// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActivityTray from "../../src/client/components/ActivityTray.svelte";
import type { ActivityItem } from "../../src/client/hooks/useNotifications.svelte";

/**
 * A23 cascade snapshot (`ActivityTray.svelte`).
 *
 * E2E covers what the cascade looks like once it is running; what it cannot
 * reach is the ordering the snapshot replaced (`:nth-child` re-indexes every
 * sibling the moment a row arrives) without racing a 1800ms window, or the
 * `$effect.pre` the snapshot depends on.
 *
 * Note what does NOT distinguish `$effect.pre` from `$effect`: reading the DOM
 * after a synchronous flush. `flushSync` keeps flushing until the queue settles,
 * so a post-render effect's write lands in a second pass and every value below
 * still ends up correct. Verified by mutation — swapping the rune leaves all the
 * content assertions green. The observable difference is that the rows are
 * *created bare and then patched*, which is what the last test watches for.
 *
 * The two tables are duplicated from the component deliberately: they are
 * module-private there, and a test that imported them could not detect a change
 * to them. Pinning the literals is the point.
 */
const CASCADE_SLIDE_Y = [240, 160, 84, 16, 8, 6];
const CASCADE_DELAY_MS = [540, 650, 760, 870, 980, 1090];

const BASE_TS = 1_700_000_000_000;

function makeItem(id: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    type: "general-error",
    severity: "info",
    message: `message ${id}`,
    timestamp: BASE_TS,
    count: 1,
    ...overrides,
  };
}

function baseProps(items: ActivityItem[], open: boolean) {
  return {
    items,
    open,
    onToggle: vi.fn(),
    onDismiss: vi.fn(),
    onClear: vi.fn(),
    onAction: vi.fn(),
    reduceMotion: false,
  };
}

/** One row per `.toast-row`, in DOM order (which is newest-first after A14). */
function readRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".toast-row")].map((el) => ({
    id: el.dataset.testid?.replace(/^activity-row-/, ""),
    cascade: el.classList.contains("cascade-row"),
    slideY: el.style.getPropertyValue("--slide-y"),
    delay: el.style.animationDelay,
  }));
}

beforeEach(() => {
  // happy-dom has no Web Animations API. A row that mounts *after* the tray is
  // already open takes `in:rowEnter`, which Svelte drives through
  // `element.animate()`. The css-only path only assigns onfinish/effect and calls
  // cancel(), so a stub that never progresses is enough.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ActivityTray cascade snapshot", () => {
  it("tags every row present at the open edge", () => {
    const { container } = render(ActivityTray, {
      props: baseProps([makeItem("a"), makeItem("b"), makeItem("c")], true),
    });

    expect(readRows(container)).toEqual([
      { id: "c", cascade: true, slideY: "240px", delay: "540ms" },
      { id: "b", cascade: true, slideY: "160px", delay: "650ms" },
      { id: "a", cascade: true, slideY: "84px", delay: "760ms" },
    ]);
  });

  it("indexes the cascade newest-first, not in store order", () => {
    // The store appends, so `items[0]` is the OLDEST. If the snapshot were taken
    // over `items` instead of the reversed `rows`, the largest --slide-y and the
    // 540ms lead would land on the bottom row and the cascade would run upside
    // down — every row would still be tagged, so only the pairing catches it.
    const { container } = render(ActivityTray, {
      props: baseProps([makeItem("oldest"), makeItem("newest")], true),
    });

    const rows = readRows(container);
    expect(rows[0]).toMatchObject({ id: "newest", slideY: "240px", delay: "540ms" });
    expect(rows[1]).toMatchObject({ id: "oldest", slideY: "160px", delay: "650ms" });
  });

  it("clamps rows past the end of the table to the last step", () => {
    const items = Array.from({ length: 8 }, (_, i) => makeItem(`i${i}`));
    const { container } = render(ActivityTray, { props: baseProps(items, true) });

    const rows = readRows(container);
    expect(rows).toHaveLength(8);
    const last = CASCADE_SLIDE_Y.length - 1;
    for (const row of rows.slice(last)) {
      expect(row).toMatchObject({
        cascade: true,
        slideY: `${CASCADE_SLIDE_Y[last]}px`,
        delay: `${CASCADE_DELAY_MS[last]}ms`,
      });
    }
    // Guard against a clamp that swallows the whole table (e.g. `Math.min(i, 0)`).
    expect(rows[0]).toMatchObject({ slideY: "240px", delay: "540ms" });
  });

  it("excludes a row that arrives after the open edge and leaves its siblings' steps intact", async () => {
    const items = [makeItem("a"), makeItem("b")];
    const { container, rerender } = render(ActivityTray, { props: baseProps(items, true) });

    await rerender(baseProps([...items, makeItem("late")], true));

    // "late" renders at the top (newest-first) and is NOT in the snapshot, so it
    // takes `in:rowEnter` with no delay instead of sitting at opacity:0 behind a
    // `both`-filled keyframe. Crucially "b" and "a" keep the steps they were
    // assigned at open — a positional selector would have re-indexed both.
    expect(readRows(container)).toEqual([
      { id: "late", cascade: false, slideY: "", delay: "" },
      { id: "b", cascade: true, slideY: "240px", delay: "540ms" },
      { id: "a", cascade: true, slideY: "160px", delay: "650ms" },
    ]);
  });

  it("re-snapshots on the next open edge rather than reusing the stale ids", async () => {
    const items = [makeItem("a"), makeItem("b")];
    const { container, rerender } = render(ActivityTray, { props: baseProps(items, true) });

    const withLate = [...items, makeItem("late")];
    await rerender(baseProps(withLate, true));
    await rerender(baseProps(withLate, false));
    await rerender(baseProps(withLate, true));

    // The open edge takes a fresh snapshot, so the row that was excluded a moment
    // ago now leads the cascade. (The close branch's own `cascadeOrder = []` is
    // belt-and-braces and NOT what this proves: the tray's body is unmounted while
    // closed, and the open branch clears the pending timer before rescheduling —
    // deleting that assignment leaves every test here green.)
    expect(readRows(container)).toEqual([
      { id: "late", cascade: true, slideY: "240px", delay: "540ms" },
      { id: "b", cascade: true, slideY: "160px", delay: "650ms" },
      { id: "a", cascade: true, slideY: "84px", delay: "760ms" },
    ]);
  });

  it("releases the snapshot once the window closes", () => {
    vi.useFakeTimers();
    const { container } = render(ActivityTray, {
      props: baseProps([makeItem("a"), makeItem("b")], true),
    });
    expect(readRows(container).every((r) => r.cascade)).toBe(true);

    // The last row lands at ~1510ms; the window is 1800ms. Rows must be released
    // afterwards, or a later arrival could never distinguish itself from a
    // cascading one.
    vi.advanceTimersByTime(1800);
    flushSync();

    expect(readRows(container)).toEqual([
      { id: "b", cascade: false, slideY: "", delay: "" },
      { id: "a", cascade: false, slideY: "", delay: "" },
    ]);
  });

  it("builds the rows already carrying their cascade step, not patched afterwards", () => {
    // The one assertion that pins `$effect.pre`. A pre-effect runs before the
    // each-block's render effect, so each row is CREATED with `.cascade-row` and
    // its inline style; a plain `$effect` creates them bare and patches both in a
    // second pass, which shows up here as class/style mutations on an element
    // that is already in the tree. Under the mutation this records 6 (3 per row);
    // as written it records none.
    //
    // It matters beyond tidiness: `.cascade-row` starts `rowSlideUp … both`, so
    // patching `animation-delay` onto an already-running animation retimes it
    // mid-flight rather than delaying its start.
    const host = document.createElement("div");
    document.body.appendChild(host);

    const observer = new MutationObserver(() => {});
    observer.observe(host, { subtree: true, childList: true, attributes: true });

    render(ActivityTray, {
      target: host,
      props: baseProps([makeItem("a"), makeItem("b")], true),
    });

    const patched = observer
      .takeRecords()
      .filter(
        (rec) =>
          rec.type === "attributes" && (rec.target as HTMLElement).classList.contains("toast-row"),
      )
      .map((rec) => rec.attributeName);
    observer.disconnect();

    expect(patched).toEqual([]);
  });
});

describe("badge pop gating (should-fix: no replay on a bare tray reopen)", () => {
  it("applies .pop the first time a row's count rises above 1", async () => {
    const item = makeItem("a", { count: 1 });
    const { container, rerender } = render(ActivityTray, { props: baseProps([item], true) });

    // count 1 renders no badge at all.
    expect(container.querySelector(".badge")).toBeNull();

    await rerender(baseProps([{ ...item, count: 2 }], true));

    const badge = container.querySelector(".badge");
    expect(badge?.textContent).toContain("2");
    expect(badge?.classList.contains("pop")).toBe(true);
  });

  it("does not replay .pop when the tray closes and reopens with no new coalesce", async () => {
    const bumped = makeItem("a", { count: 2 });
    const { container, rerender } = render(ActivityTray, { props: baseProps([bumped], true) });

    // First sight of count 2 pops.
    expect(container.querySelector(".badge")?.classList.contains("pop")).toBe(true);

    // Tray closes: `.tray-inner` (and the badge span inside it) unmounts entirely.
    await rerender(baseProps([bumped], false));
    expect(container.querySelector(".badge")).toBeNull();

    // Tray reopens with the SAME count. The badge remounts (fresh DOM node,
    // per the `{#key item.count}` / ancestor-teardown comment) but must NOT
    // replay the pop, since nothing changed while it was closed.
    await rerender(baseProps([bumped], true));
    const badge = container.querySelector(".badge");
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains("pop")).toBe(false);
  });

  it("still pops on reopen when a genuine coalesce happened while the tray was closed", async () => {
    const item = makeItem("a", { count: 2 });
    const { container, rerender } = render(ActivityTray, { props: baseProps([item], true) });
    expect(container.querySelector(".badge")?.classList.contains("pop")).toBe(true);

    await rerender(baseProps([item], false));

    // A real coalesce bump lands while the tray is closed; reopening should
    // show the user the pop they haven't seen yet.
    await rerender(baseProps([{ ...item, count: 3 }], true));

    const badge = container.querySelector(".badge");
    expect(badge?.textContent).toContain("3");
    expect(badge?.classList.contains("pop")).toBe(true);
  });
});

describe("open tray dismissal", () => {
  it("closes on an outside pointerdown but not on interaction inside the shell", () => {
    const onToggle = vi.fn();
    const props = { ...baseProps([makeItem("a")], true), onToggle };
    const { container } = render(ActivityTray, { props });

    container
      .querySelector<HTMLElement>("[data-testid='activity-tray']")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not close/reopen on the pill pointerdown and click sequence", () => {
    const onToggle = vi.fn();
    const { container } = render(ActivityTray, {
      props: { ...baseProps([], true), onToggle },
    });
    const pill = container.querySelector<HTMLButtonElement>("[data-testid='activity-pill']")!;

    pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    pill.click();

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and returns focus to the persistent pill", async () => {
    const onToggle = vi.fn();
    const { container } = render(ActivityTray, {
      props: { ...baseProps([], true), onToggle },
    });
    const pill = container.querySelector<HTMLButtonElement>("[data-testid='activity-pill']")!;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(pill);
  });
});
