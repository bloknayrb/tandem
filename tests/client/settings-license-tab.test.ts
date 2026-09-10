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
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants";

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

describe("Settings → License — a failed status poll is visible (#1789)", () => {
  /**
   * The `status === null` seam: `stop()` never clears `status` and `set()`
   * always assigns a non-null one, so this row is reachable ONLY by letting the
   * very first poll of a fresh module instance reject. Asserted in the same
   * test rather than assumed.
   *
   * **This describe must stay FIRST in the file.** The CLI-hint block below
   * seeds a status through `licenseStore.set()` to exercise the server-side
   * `cliActivateEffective` flag, and the singleton keeps it — so running that
   * one first makes `status` non-null here and this row unreachable. The
   * `expect(...).toBeNull()` above is what turns that mistake into a failure
   * rather than a silently weaker test.
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

  /**
   * Review round 1. The block is inserted and removed under a live Settings
   * tab, so without a live-region role a screen-reader user keeps reading a
   * pill and countdown the page has just stopped vouching for — the exact
   * silent staleness it exists to end. `status`, not `alert`: it is transient
   * and self-clearing on the next successful poll.
   */
  it("the live region is present and polite BEFORE the warning appears", async () => {
    // Review round 2: the container is what must already be in the
    // accessibility tree. NVDA/JAWS announce CHANGES to a live region they
    // were already tracking; a node inserted with its text already present is
    // routinely missed — and that insertion is the only case this block has.
    fetchLicenseStatus.mockResolvedValue(TRIAL);
    await licenseStore.refresh();
    await flush();

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const region = byTestId(container, "license-status-live-region");
    expect(region).toBeTruthy();
    // Polite, not `alert`: transient and self-clearing on the next good poll.
    expect(region?.getAttribute("role")).toBe("status");
    // Empty while healthy — it must occupy no space and say nothing.
    expect(byTestId(container, "license-status-unavailable")).toBeNull();
    expect(flat(region)).toBe("");
  });

  it("the warning renders INSIDE that same live region", async () => {
    fetchLicenseStatus.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await licenseStore.refresh();
    await flush();

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const warning = byTestId(container, "license-status-unavailable");
    expect(warning).toBeTruthy();
    // A warning rendered as a SIBLING of the region announces nothing, which is
    // the pre-fix behaviour under a different shape.
    expect(byTestId(container, "license-status-live-region")?.contains(warning)).toBe(true);
  });

  it("a healthy poll renders no warning", async () => {
    fetchLicenseStatus.mockResolvedValue(TRIAL);
    await licenseStore.refresh();
    await flush();

    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(byTestId(container, "license-status-unavailable")).toBeNull();
  });
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
    // Review round 2: seed the SERVER half true, so `isDesktop` is the only
    // thing that can hide the clause. Without this the singleton still held the
    // first describe's status, which carries no `cliActivateEffective` at all
    // — the hint was already hidden by the other half of the `&&`, and
    // dropping `!isDesktop &&` from the template left every test in this file
    // green (verified by mutation).
    licenseStore.set({ ...TRIAL, cliActivateEffective: true });
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const section = byTestId(container, "license-settings-section");
    expect(flat(section)).not.toContain("tandem activate");
    expect(flat(section)).toContain("Paste a license key");
  });

  it("browser/npm keeps it", () => {
    tauri = false;
    // The server's half of the discriminant: this process reads the npm
    // env-paths root, so the command it names would land where it reads.
    licenseStore.set({ ...TRIAL, cliActivateEffective: true });
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(flat(byTestId(container, "license-settings-section"))).toContain("tandem activate");
  });

  /**
   * Review round 1. `isTauriRuntime()` is a WebView test, not a test of which
   * app-data root the server uses — and a desktop install serves this very
   * client on `http://127.0.0.1:3479` (`bundle.resources` ships `dist/client/`).
   * Opened there in a browser the runtime check reads FALSE, so the withdrawn
   * hint came back on the one install where following it writes `license.json`
   * into a directory the desktop never reads. Only the server can tell the
   * roots apart, so `cliActivateEffective` decides.
   */
  it("the desktop's own client in a browser offers no command either", () => {
    tauri = false;
    licenseStore.set({ ...TRIAL, cliActivateEffective: false });
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    const section = byTestId(container, "license-settings-section");
    expect(flat(section)).not.toContain("tandem activate");
    expect(flat(section)).toContain("Paste a license key");
  });

  /** Absence is not permission: an older server, or the LAN-scrubbed payload,
   *  sends no flag at all, and the hint must stay withdrawn. */
  it("a payload with no flag at all hides it", () => {
    tauri = false;
    licenseStore.set({ ...TRIAL });
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(flat(byTestId(container, "license-settings-section"))).not.toContain("tandem activate");
  });
});

/**
 * Review round 2. `window_ended_copy` (src-tauri/src/lib.rs) tells a licensed
 * user whose window has lapsed to "renew from Settings -> License", and its
 * docblock justifies naming that surface with the claim that the tab holds the
 * clickable link a native message box cannot. Before this, the only outbound
 * link on the tab was `license-buy-link`, framed "Don't have one yet? Buy a
 * license" — an offer to buy what the reader already owns. The dialog closed a
 * loop with no exit. This is the test that keeps the Rust docblock honest.
 */
describe("Settings → License — the ended update window offers a way out (#1819)", () => {
  const LAPSED: LicenseStatusResponse = {
    gateActive: true,
    status: "licensed",
    updateWindowCurrent: false,
    license: { name: "Paying Customer", type: "paid" },
  };

  it("the ended-window warning carries a renewal link", () => {
    licenseStore.set(LAPSED);
    const { container } = render(SettingsLicenseTab, { props: makeProps() });

    const warning = byTestId(container, "license-update-window-ended");
    expect(warning).toBeTruthy();
    const renew = byTestId(container, "license-renew-link") as HTMLAnchorElement | null;
    expect(renew).toBeTruthy();
    // Inside the warning, not somewhere else on the tab: the "Buy a license"
    // link already existed further down and is not an answer for a holder.
    expect(warning?.contains(renew)).toBe(true);
    expect(renew?.getAttribute("href")).toBe(TANDEM_PURCHASE_URL);
    expect(renew?.getAttribute("rel")).toContain("noopener");
    expect(flat(renew).toLowerCase()).toContain("renew");
  });

  it("a current window shows neither the warning nor the renewal link", () => {
    licenseStore.set({ ...LAPSED, updateWindowCurrent: true });
    const { container } = render(SettingsLicenseTab, { props: makeProps() });
    expect(byTestId(container, "license-update-window-ended")).toBeNull();
    expect(byTestId(container, "license-renew-link")).toBeNull();
  });
});
