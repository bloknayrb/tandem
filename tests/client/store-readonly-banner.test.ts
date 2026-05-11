// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import StoreReadOnlyBannerHarness from "../../src/client/svelte-harness/StoreReadOnlyBannerHarness.svelte";
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
    expect(banner?.textContent).toContain("Close the other instance and restart");
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
