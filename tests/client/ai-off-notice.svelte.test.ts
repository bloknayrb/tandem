// @vitest-environment happy-dom

/**
 * The rail's "AI features are off" notice (#1521), mounted.
 *
 * It keys on `licenseStore.ui.aiNotice`, so every dark build renders nothing.
 * The unverifiable body is the code-specific copy and must never carry the
 * purchase URL: that reader most likely already paid (ADR-040 decision 8). The
 * collapse toggle persists per browser, and a storage-disabled browser still
 * gets the notice, expanded.
 *
 * `licenseStore` is a module singleton, so each test seeds it with `set()` and
 * the afterEach returns it to a dark state. Auto-cleanup never registers in
 * this repo's client project, so each render is unmounted explicitly.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiOffNotice from "../../src/client/components/AiOffNotice.svelte";
import { licenseStore } from "../../src/client/hooks/useLicense.svelte";
import { aiOffCopy, type LicenseStatusResponse } from "../../src/client/utils/license-ui";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants";
import type { LicenseUnverifiableCode } from "../../src/shared/license-copy";

const KEY = "tandem:ai-off-notice-collapsed";
const DARK: LicenseStatusResponse = {
  gateActive: false,
  status: "restricted",
  updateWindowCurrent: true,
};
const UNLICENSED: LicenseStatusResponse = {
  gateActive: true,
  status: "restricted",
  updateWindowCurrent: false,
};
const UNVERIFIABLE: LicenseStatusResponse = { ...UNLICENSED, licenseUnverifiable: "BAD_SIGNATURE" };

const PROPS = { onOpenLicenseSettings: () => {} };

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid='${id}']`);
const text = (c: HTMLElement) => (c.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable in this environment */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  licenseStore.set(DARK);
  vi.restoreAllMocks();
});

describe("AiOffNotice", () => {
  it("renders nothing on a dark build", () => {
    licenseStore.set(DARK);
    const { container, unmount } = render(AiOffNotice, { props: PROPS });
    expect(q(container, "ai-off-notice")).toBeNull();
    unmount();
  });

  it("unlicensed: says the AI is off, and its link opens Settings → License", async () => {
    licenseStore.set(UNLICENSED);
    const onOpen = vi.fn();
    const { container, unmount } = render(AiOffNotice, {
      props: { onOpenLicenseSettings: onOpen },
    });
    const root = q(container, "ai-off-notice");
    expect(root?.getAttribute("role")).toBe("status");
    expect(text(container)).toContain(aiOffCopy("unlicensed").sentence);
    q(container, "ai-off-notice-settings-link")?.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    unmount();
  });

  // Every reason code, not one: the body is `aiRefusalUnverifiableMessage(code)`,
  // whose per-code half `aiOffCopy` does not carry. A `Record` so a new code
  // fails to compile here until it is listed.
  const CODES = Object.keys({
    TOO_LONG: true,
    MALFORMED: true,
    BAD_SIGNATURE: true,
    UNSUPPORTED_VERSION: true,
    WRITE_FAILED: true,
    UNKNOWN: true,
  } satisfies Record<LicenseUnverifiableCode, true>) as LicenseUnverifiableCode[];

  it.each(CODES)("unverifiable %s: never 'unlicensed', 'Activate a license' or a URL", (code) => {
    licenseStore.set({ ...UNLICENSED, licenseUnverifiable: code });
    const { container, unmount } = render(AiOffNotice, { props: PROPS });
    const t = text(container);
    expect(t).toContain("could not be verified");
    expect(t).not.toMatch(/unlicensed/i);
    // "Activate it again from the key you were sent" (a damaged file) is a
    // repair, not a purchase prompt; the line drawn is "Activate a license".
    expect(t).not.toContain("Activate a license");
    expect(t).not.toMatch(/https?:/);
    unmount();
  });

  it("unverifiable: the code-specific copy, no purchase URL, no 'unlicensed'", () => {
    licenseStore.set(UNVERIFIABLE);
    const { container, unmount } = render(AiOffNotice, { props: PROPS });
    const t = text(container);
    expect(t).toContain("could not be verified");
    expect(t).not.toContain(TANDEM_PURCHASE_URL);
    expect(t).not.toMatch(/unlicensed/i);
    expect(container.querySelector(`a[href='${TANDEM_PURCHASE_URL}']`)).toBeNull();
    unmount();
  });

  it("the collapsed line follows the kind", async () => {
    for (const [state, expectUnlicensed] of [
      [UNLICENSED, true],
      [UNVERIFIABLE, false],
    ] as const) {
      licenseStore.set(state);
      localStorage.setItem(KEY, "1");
      const { container, unmount } = render(AiOffNotice, { props: PROPS });
      expect(q(container, "ai-off-notice-settings-link")).toBeNull();
      const t = text(container);
      expect(/unlicensed/i.test(t)).toBe(expectUnlicensed);
      expect(t).not.toContain("Activate a license");
      unmount();
    }
  });

  it("collapse persists across mounts", async () => {
    licenseStore.set(UNLICENSED);
    const first = render(AiOffNotice, { props: PROPS });
    const toggle = q(first.container, "ai-off-notice-collapse");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    toggle?.click();
    await tick();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(KEY)).toBe("1");
    first.unmount();

    const second = render(AiOffNotice, { props: PROPS });
    expect(q(second.container, "ai-off-notice-collapse")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    second.unmount();
  });

  it("a storage-disabled browser still renders the notice, expanded", async () => {
    licenseStore.set(UNLICENSED);
    const getItem = vi.fn(() => {
      throw new Error("SecurityError");
    });
    vi.stubGlobal("localStorage", {
      getItem,
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
    });
    const { container, unmount } = render(AiOffNotice, { props: PROPS });
    const toggle = q(container, "ai-off-notice-collapse");
    expect(q(container, "ai-off-notice")).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // Toggling still works in memory.
    toggle?.click();
    await tick();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // The read really went through the throwing storage.
    expect(getItem).toHaveBeenCalled();
    unmount();
  });
});
