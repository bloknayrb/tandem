// @vitest-environment happy-dom

/**
 * Settings → License, mounted (#1789).
 *
 * **Required — no source-level fallback.** After the fix both branch strings
 * live in one file, so any source read matches `tandem activate` whichever arm
 * actually renders. Likewise for the unavailability line: the testid snapshot
 * (`testid-coverage.test.ts`) extracts ids from **file text**, so an `{#if}`
 * that never fires passes it.
 *
 * Precedents: `settings-push-routes.test.ts` (mutable-cell `vi.mock` of the
 * same `isTauriRuntime` discriminant, then `render(...)` of a settings tab) and
 * `cowork-settings-mounted.test.ts`.
 */

import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import type { LicenseStatusResponse } from "../../src/client/utils/license-ui";

// Set BEFORE mount — the tab captures it once at init, which is the point of
// the fix (the runtime never changes under a live component).
let tauri = false;
vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => tauri };
});

const fetchLicenseStatus = vi.fn<() => Promise<LicenseStatusResponse>>();
vi.mock("../../src/client/hooks/useLicense", () => ({
  fetchLicenseStatus: () => fetchLicenseStatus(),
  activateLicenseClient: vi.fn(),
}));

const { licenseStore } = await import("../../src/client/hooks/useLicense.svelte");
const SettingsLicenseTab = (
  await import("../../src/client/components/settings-tabs/SettingsLicenseTab.svelte")
).default;

const TRIAL: LicenseStatusResponse = {
  gateActive: true,
  status: "trial",
  updateWindowCurrent: false,
  trial: { daysRemaining: 5 },
};

function makeProps() {
  return {
    open: true,
    settings: {
      selectionDwellMs: 1000,
      selectionToolbar: true,
      marginView: false,
    } as TandemSettings,
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly: false,
    notify: vi.fn(),
  };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);
const flat = (el: HTMLElement | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Flush the microtask queue so an in-flight poll's awaited fetch settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  fetchLicenseStatus.mockReset();
  licenseStore.stop();
});

afterEach(() => {
  licenseStore.stop();
  tauri = false;
  vi.restoreAllMocks();
});

describe("Settings → License — the CLI hint is browser/npm only (#1789)", () => {
  /**
   * The NEGATIVE is the point of (a): the desktop bundle ships no `tandem`
   * binary (`bundle.resources` carries no `dist/cli`; `externalBin` is the two
   * sidecars), and a separately installed npm CLI writes `license.json` under
   * its own app-data root, which the desktop never reads. A fix that adds paste
   * copy without removing the CLI offer passes any "mentions paste" assertion.
   */
  it("desktop offers no command to run", () => {
    tauri = true;
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const section = byTestId(container, "license-settings-section");
    expect(flat(section)).not.toContain("tandem activate");
    expect(flat(section)).toContain("Paste a license key");
  });

  it("browser/npm keeps it", () => {
    tauri = false;
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(flat(byTestId(container, "license-settings-section"))).toContain("tandem activate");
  });
});

describe("Settings → License — a failed status poll is visible (#1789)", () => {
  /**
   * The `status === null` seam: `stop()` never clears `status` and `set()`
   * always assigns a non-null one, so this row is reachable ONLY by letting the
   * very first poll of a fresh module instance reject. Asserted in the same
   * test rather than assumed.
   */
  it("no status at all ⇒ unknown pill, no last-known-state wording", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("ECONNREFUSED"));
    await licenseStore.refresh();
    await flush();
    expect(licenseStore.status).toBeNull();
    expect(licenseStore.statusUnavailable).toBe(true);

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const warning = byTestId(container, "license-status-unavailable");
    expect(warning).toBeTruthy();
    expect(flat(warning)).not.toContain("last known state");
    expect(flat(warning)).toContain("hasn't reached");
    // The pill is the discriminating surface: this is where the unconditional
    // fallback used to assert the gate was off with no evidence at all.
    expect(flat(byTestId(container, "license-status-pill"))).not.toBe(
      "Not enforced in this version",
    );
  });

  it("a stale status ⇒ the warning carries the last-known-state wording", async () => {
    fetchLicenseStatus.mockResolvedValueOnce(TRIAL);
    await licenseStore.refresh();
    await flush();
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await licenseStore.refresh();
    await flush();

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const warning = byTestId(container, "license-status-unavailable");
    expect(warning).toBeTruthy();
    expect(flat(warning)).toContain("last known state");
  });

  it("a healthy poll renders no warning", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL);
    await licenseStore.refresh();
    await flush();

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(byTestId(container, "license-status-unavailable")).toBeNull();
  });
});
