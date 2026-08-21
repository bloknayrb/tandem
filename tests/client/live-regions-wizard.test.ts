// @vitest-environment happy-dom

/**
 * #1431 — the wizard's three progress lines.
 *
 * `loadingDots` is rendered at three call sites and each one is inside the
 * `{#if}` that decides whether that progress line exists, so the `aria-live`
 * it carried was inserted together with its sentence every single time. One
 * announcer mounted with the dialog replaces all three.
 *
 * Split from `live-regions.test.ts` because the wizard's four hooks have to be
 * stubbed; the shape of the assertions and why the *pair* matters are
 * documented there.
 *
 * Honest limit, also recorded in the component: the real `detecting` is
 * `$state(true)` at construction, so the very first "Looking for Claude…" of a
 * freshly-opened wizard is still in the region's opening commit and cannot
 * announce. Every later occurrence can. The stub starts `detecting` false so
 * these tests exercise the transitions that *are* fixable.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";
import { wizardProgressCell } from "../helpers/wizard-progress-cell.svelte";

vi.mock("../../src/client/hooks/useIntegrationWizard.svelte", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createIntegrationWizard: () => ({
    get step() {
      return wizardProgressCell.step;
    },
    get detecting() {
      return wizardProgressCell.detecting;
    },
    existing: [],
    picked: [],
    applyResults: [],
    channelRegistered: null,
    errorMessage: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    cleanupUnsavedSecrets: vi.fn(async () => {}),
  }),
}));

vi.mock("../../src/client/hooks/useReachabilityCheck.svelte", () => ({
  createReachabilityCheck: () => ({
    get phase() {
      return wizardProgressCell.phase;
    },
    serverUp: null,
    claudeConnected: false,
    results: [],
  }),
}));

vi.mock("../../src/client/hooks/useClaudeCliStatus.svelte", () => ({
  createClaudeCliStatus: () => ({
    presence: null,
    bareNameLaunchable: null,
    loading: false,
    error: null,
    installing: false,
    installError: null,
    install: vi.fn(async () => null),
    refetch: vi.fn(async () => {}),
  }),
}));

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: coworkStatusFixture(),
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => vi.fn()),
  coworkToggleIntegration: vi.fn(async () => ({ ok: true })),
  coworkPreflightSubnet: vi.fn(async () => ({ status: "unknown" })),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

beforeEach(() => wizardProgressCell.reset());
afterEach(cleanup);

function q(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid='${testid}']`);
}

const LIVE = "integration-wizard-progress-live";

describe("IntegrationWizardModal progress live region", () => {
  it("mounts one region with the dialog and fills that same node on each step", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });

    // Half 1 — present, a status region, and silent while nothing is in flight.
    const before = q(container, LIVE);
    expect(before, "the progress region must be mounted with the dialog").toBeTruthy();
    expect(before?.getAttribute("role")).toBe("status");
    expect(before?.getAttribute("aria-live")).toBe("polite");
    expect(before?.textContent?.trim()).toBe("");

    // Half 2 — the text lands in the node that was already there, three times
    // over, which is the whole point of collapsing three call sites into one
    // region.
    wizardProgressCell.set({ detecting: true });
    await tick();
    expect(q(container, LIVE)).toBe(before);
    expect(before?.textContent).toContain("Looking for Claude on your computer");

    wizardProgressCell.set({ detecting: false, step: "applying" });
    await tick();
    expect(q(container, LIVE)).toBe(before);
    expect(before?.textContent).toContain("Connecting Claude");

    wizardProgressCell.set({ step: "done", phase: "verifying" });
    await tick();
    expect(q(container, LIVE)).toBe(before);
    expect(before?.textContent).toContain("Verifying Claude can reach Tandem");
  });

  it("leaves no live semantics on the loadingDots node it replaced", async () => {
    wizardProgressCell.set({ detecting: true });
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    const dots = container.querySelector<HTMLElement>(".iw-loading");
    expect(dots, "the visible progress line should still render").toBeTruthy();
    // It used to carry `aria-live="polite"` on a node its own `{#if}` created.
    expect(dots?.getAttribute("aria-live")).toBeNull();
    // And it must be hidden, or the announcer's sentence is in the tree twice.
    expect(dots?.getAttribute("aria-hidden")).toBe("true");
    expect(q(container, LIVE)?.getAttribute("aria-hidden")).toBeNull();
  });
});
