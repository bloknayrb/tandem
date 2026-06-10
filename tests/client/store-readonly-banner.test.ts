// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import StoreReadOnlyBannerHarness from "../../src/client/svelte-harness/StoreReadOnlyBannerHarness.svelte";
import { API_STORE_RECLAIM_LOCK } from "../../src/shared/api-paths.js";
import { Y_MAP_DOCUMENT_META, Y_MAP_STORE_READ_ONLY } from "../../src/shared/constants.js";

const DISMISS_KEY = "tandem:storeReadOnlyBannerDismissed";

describe("SidePanel store-read-only banner", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders the banner when storeReadOnly is true and not previously dismissed", async () => {
    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    const banner = container.querySelector("[data-testid='store-readonly-banner']");
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("Annotation store is read-only");
    expect(banner?.textContent).toContain("Close the other instance");
  });

  it("hides the banner and persists dismissal to localStorage when the dismiss button is clicked", async () => {
    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    const banner = container.querySelector("[data-testid='store-readonly-banner']");
    expect(banner).toBeTruthy();

    const dismissBtn = container.querySelector(
      "[data-testid='store-readonly-dismiss']",
    ) as HTMLButtonElement | null;
    expect(dismissBtn).toBeTruthy();
    dismissBtn?.click();
    await tick();

    expect(container.querySelector("[data-testid='store-readonly-banner']")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("true");
  });

  it("does not render the banner when previously dismissed via localStorage", async () => {
    localStorage.setItem(DISMISS_KEY, "true");

    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    expect(container.querySelector("[data-testid='store-readonly-banner']")).toBeNull();
  });

  it("resets dismissal when storeReadOnly transitions back to false", async () => {
    const { container, rerender } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    // Dismiss the banner
    const dismissBtn = container.querySelector(
      "[data-testid='store-readonly-dismiss']",
    ) as HTMLButtonElement;
    dismissBtn.click();
    await tick();
    expect(container.querySelector("[data-testid='store-readonly-banner']")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("true");

    // storeReadOnly goes false — clears dismissal
    await rerender({ storeReadOnly: false });
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();

    // storeReadOnly goes true again — banner reappears
    await rerender({ storeReadOnly: true });
    expect(container.querySelector("[data-testid='store-readonly-banner']")).toBeTruthy();
  });
});

describe("store-read-only banner Reclaim button (#1077)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("POSTs to the reclaim endpoint when clicked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { reclaimed: true } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    const reclaimBtn = container.querySelector(
      "[data-testid='store-readonly-reclaim']",
    ) as HTMLButtonElement | null;
    expect(reclaimBtn).toBeTruthy();
    reclaimBtn?.click();
    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(API_STORE_RECLAIM_LOCK);
    expect(init.method).toBe("POST");

    // Success path shows no inline error; the banner clears when the server
    // broadcasts storeReadOnly=false (driven by the prop, not local state).
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid='store-readonly-reclaim-error']")).toBeNull();
    });
  });

  it("surfaces the server's structured error message inline on 409", async () => {
    const message = 'The lock is held by a running process ("node", PID 4242).';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "LOCK_HELD", message }), { status: 409 }),
        ),
    );

    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    (
      container.querySelector("[data-testid='store-readonly-reclaim']") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='store-readonly-reclaim-error']");
      expect(error?.textContent).toContain("PID 4242");
    });
    // Banner stays visible so the user can retry or dismiss.
    expect(container.querySelector("[data-testid='store-readonly-banner']")).toBeTruthy();
  });

  it("shows a generic error when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const { container } = render(StoreReadOnlyBannerHarness, {
      props: { storeReadOnly: true },
    });
    await tick();

    (
      container.querySelector("[data-testid='store-readonly-reclaim']") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='store-readonly-reclaim-error']");
      expect(error?.textContent).toContain("Could not reach the Tandem server");
    });
  });
});

describe("Y.Map → storeReadOnly bootstrap-observer contract", () => {
  // This documents the Y.Map key the server writes and the client observes.
  // The full wiring (yjsSync.svelte.ts:319) reads keysChanged.has(Y_MAP_STORE_READ_ONLY)
  // and copies meta.get(Y_MAP_STORE_READ_ONLY) === true into the storeReadOnly rune.
  it("propagates Y_MAP_STORE_READ_ONLY writes to observers on the documentMeta map", async () => {
    const ydoc = new Y.Doc();
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);

    let observed: boolean | undefined;
    let sawKey = false;
    meta.observe((event) => {
      if (event.keysChanged.has(Y_MAP_STORE_READ_ONLY)) {
        sawKey = true;
        observed = (meta.get(Y_MAP_STORE_READ_ONLY) as boolean | undefined) === true;
      }
    });

    meta.set(Y_MAP_STORE_READ_ONLY, true);
    expect(sawKey).toBe(true);
    expect(observed).toBe(true);

    sawKey = false;
    meta.set(Y_MAP_STORE_READ_ONLY, false);
    expect(sawKey).toBe(true);
    expect(observed).toBe(false);

    ydoc.destroy();
  });
});
