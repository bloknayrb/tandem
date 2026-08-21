// @vitest-environment happy-dom

/**
 * #1431 — the live regions that never announced.
 *
 * **The mechanism, once.** A screen reader speaks a *mutation* to a region that
 * was already in the accessibility tree. A region inserted together with its
 * text is commonly read out by nothing at all. Every site fixed here carried
 * `role="status"` / `aria-live="polite"` on the very node its `{#if}` created.
 *
 * **What that means for these tests.** An assertion that the attribute is
 * present proves nothing — it was present before this PR too, on all thirteen
 * sites, while none of them announced. This sweep found seven existing tests
 * that passed identically with the thing they pinned deleted. So every case
 * below asserts the *pair*:
 *
 *   1. the region exists and is EMPTY before its content exists, and
 *   2. after the state flips, the text is inside the SAME DOM NODE
 *      (`toBe`, not `toBeTruthy`) — i.e. a mutation, not an insertion.
 *
 * Neither half alone is load-bearing. (1) alone passes against a change that
 * only moved the attribute; (2) alone passes against today's broken shape,
 * where the node is created with its text. A third assertion — that the visible
 * node is no longer a live region — is only meaningful stated together with
 * (1), since on its own it would pass against deleting the region outright.
 *
 * Model: `tests/client/cowork-onboarding-step-mounted.test.ts`.
 *
 * **What these tests do NOT prove.** No screen reader exists in this
 * environment, and neither happy-dom nor axe can observe speech — there is no
 * axe rule at any tag set that detects a live region inserted with its content.
 * These pin the structural precondition, which is necessary, is exactly what
 * was false, and is the most any automated check here can reach.
 */

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import ConnectionBanner from "../../src/client/components/ConnectionBanner.svelte";
import ExternalConflictBanner from "../../src/client/components/ExternalConflictBanner.svelte";
import FidelityReportBanner from "../../src/client/components/FidelityReportBanner.svelte";
import LicenseBanner from "../../src/client/components/LicenseBanner.svelte";
import ReviewOnlyBanner from "../../src/client/components/ReviewOnlyBanner.svelte";
import UpdaterBanner from "../../src/client/components/UpdaterBanner.svelte";
import WakeStallBanner from "../../src/client/components/WakeStallBanner.svelte";
import SourceView from "../../src/client/editor/SourceView.svelte";
import { licenseStore } from "../../src/client/hooks/useLicense.svelte";
import type { LicenseStatusResponse } from "../../src/client/utils/license-ui";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_FIDELITY_REPORT,
} from "../../src/shared/constants.js";
import type { ExternalConflictState, FidelityReport } from "../../src/shared/types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function q(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid='${testid}']`);
}

/**
 * Half 1 of the pair: the region is in the tree, is a `status` region, and has
 * nothing to say yet. Returns the node so the caller can pin identity.
 */
function mountedEmpty(root: ParentNode, testid: string): HTMLElement {
  const region = q(root, testid);
  expect(region, `no live region '${testid}' — it must exist BEFORE its text`).toBeTruthy();
  expect(region?.getAttribute("role")).toBe("status");
  expect(region?.getAttribute("aria-live")).toBe("polite");
  expect(region?.textContent?.trim()).toBe("");
  return region as HTMLElement;
}

/** Half 3: the visible node must no longer own live semantics of its own. */
function notALiveRegion(node: HTMLElement | null): void {
  expect(node).toBeTruthy();
  expect(node?.getAttribute("role")).toBeNull();
  expect(node?.getAttribute("aria-live")).toBeNull();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape 1 — persistent host wrapping the `{#if}`
// ─────────────────────────────────────────────────────────────────────────────

describe("ConnectionBanner live region", () => {
  const props = (visible: boolean) => ({ visible, onDismiss: vi.fn(), onRetry: vi.fn() });

  it("mounts the region before the disconnect message, then fills that same node", async () => {
    const { container, rerender } = render(ConnectionBanner, { props: props(false) });
    const before = mountedEmpty(container, "connection-banner-live");
    expect(q(container, "connection-banner")).toBeNull();

    await rerender(props(true));

    expect(q(container, "connection-banner-live")).toBe(before);
    expect(before.textContent).toContain("We've lost the connection");
    notALiveRegion(q(container, "connection-banner"));
  });

  it("empties without being torn down when the banner is dismissed", async () => {
    const { container, rerender } = render(ConnectionBanner, { props: props(true) });
    const region = q(container, "connection-banner-live");
    await rerender(props(false));
    expect(q(container, "connection-banner-live")).toBe(region);
    expect(region?.textContent?.trim()).toBe("");
  });
});

describe("UpdaterBanner live region", () => {
  const props = (visible: boolean, version: string | null) => ({
    visible,
    version,
    installing: false,
    onInstall: vi.fn(),
    onDismiss: vi.fn(),
  });

  it("mounts the region before the update message, then fills that same node", async () => {
    const { container, rerender } = render(UpdaterBanner, { props: props(false, null) });
    const before = mountedEmpty(container, "updater-banner-live");
    expect(q(container, "updater-banner")).toBeNull();

    await rerender(props(true, "9.9.9"));

    expect(q(container, "updater-banner-live")).toBe(before);
    expect(before.textContent).toContain("9.9.9");
    notALiveRegion(q(container, "updater-banner"));
  });

  it("tracks a second version without replacing the region", async () => {
    // Pure markup today, so this is trivially true — it exists so that
    // reintroducing any effect-based or one-shot writer goes red.
    const { container, rerender } = render(UpdaterBanner, { props: props(true, "1.0.0") });
    const region = q(container, "updater-banner-live");
    await rerender(props(true, "2.0.0"));
    expect(q(container, "updater-banner-live")).toBe(region);
    expect(region?.textContent).toContain("2.0.0");
  });
});

describe("LicenseBanner live region", () => {
  const trial = (daysRemaining: number): LicenseStatusResponse => ({
    gateActive: true,
    status: "trial",
    trial: { daysRemaining },
    updateWindowCurrent: true,
  });
  const dark: LicenseStatusResponse = {
    gateActive: false,
    status: "licensed",
    updateWindowCurrent: true,
  };

  // Module-level singleton (#737): reset it so neither ordering nor another
  // file inherits a trial.
  beforeEach(() => licenseStore.set(dark));
  afterEach(() => licenseStore.set(dark));

  it("mounts the region before the trial countdown, then fills that same node", async () => {
    const { container } = render(LicenseBanner);
    const before = mountedEmpty(container, "license-banner-live");
    expect(q(container, "license-trial-banner")).toBeNull();

    licenseStore.set(trial(5));
    await tick();

    expect(q(container, "license-banner-live")).toBe(before);
    expect(before.textContent).toContain("left in your Tandem trial");
    notALiveRegion(q(container, "license-trial-banner"));
  });
});

describe("WakeStallBanner live region", () => {
  it("mounts the region before the stall notice, then fills that same node", async () => {
    const { container, rerender } = render(WakeStallBanner, { props: { stalledMs: null } });
    const before = mountedEmpty(container, "wake-stall-live");
    expect(q(container, "wake-stall-banner")).toBeNull();

    await rerender({ stalledMs: 180_000 });

    expect(q(container, "wake-stall-live")).toBe(before);
    expect(before.textContent).toContain("3 minutes");
    notALiveRegion(q(container, "wake-stall-banner"));
  });

  it("follows a growing wait without replacing the region", async () => {
    const { container, rerender } = render(WakeStallBanner, { props: { stalledMs: 120_000 } });
    const region = q(container, "wake-stall-live");
    await rerender({ stalledMs: 300_000 });
    expect(q(container, "wake-stall-live")).toBe(region);
    expect(region?.textContent).toContain("5 minutes");
  });
});

describe("ReviewOnlyBanner live region", () => {
  const props = (visible: boolean) => ({ visible, documentId: "doc-1" });

  it("mounts the region before the review-only notice, then fills that same node", async () => {
    const { container, rerender } = render(ReviewOnlyBanner, { props: props(false) });
    const before = mountedEmpty(container, "review-only-live");
    expect(q(container, "review-only-banner")).toBeNull();

    await rerender(props(true));

    expect(q(container, "review-only-live")).toBe(before);
    expect(before.textContent).toContain("review-only mode");
    notALiveRegion(q(container, "review-only-banner"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape 2 — permanently-mounted sr-only announcer beside the visible node
// ─────────────────────────────────────────────────────────────────────────────

describe("ExternalConflictBanner live region", () => {
  const props = (ydoc: Y.Doc) => ({ ydoc, documentId: "d1", fileName: "notes.md", format: "md" });
  const conflict: ExternalConflictState = {
    kind: "external-edit",
    diskChanged: true,
    detectedAt: 1,
  };

  it("mounts the announcer before the conflict, then fills that same node", async () => {
    const ydoc = new Y.Doc();
    const { container } = render(ExternalConflictBanner, { props: props(ydoc) });
    const before = mountedEmpty(container, "external-conflict-live");
    expect(q(container, "external-conflict-banner")).toBeNull();

    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, conflict);
    await tick();

    expect(q(container, "external-conflict-live")).toBe(before);
    expect(before.textContent).toContain("notes.md");
    notALiveRegion(q(container, "external-conflict-banner"));
  });

  it("hides the duplicated visible message but never the controls", async () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, conflict);
    const { container } = render(ExternalConflictBanner, { props: props(ydoc) });
    await tick();

    const message = container.querySelector<HTMLElement>(".tandem-banner__message");
    expect(message?.getAttribute("aria-hidden")).toBe("true");
    expect(q(container, "external-conflict-live")?.getAttribute("aria-hidden")).toBeNull();

    // `aria-hidden` on the banner div would take these out of the a11y tree.
    for (const id of ["external-conflict-keep-btn", "external-conflict-reload-btn"]) {
      const btn = q(container, id);
      expect(btn, id).toBeTruthy();
      expect(btn?.closest("[aria-hidden='true']"), `${id} is inside an aria-hidden subtree`).toBe(
        null,
      );
    }
  });
});

describe("FidelityReportBanner live regions", () => {
  const props = (ydoc: Y.Doc) => ({ ydoc, documentId: "d1", fileName: "report.docx" });
  const losses: FidelityReport = {
    importLosses: ["Footnotes were not imported"],
    exportDowngrades: [],
    integrityWarnings: [],
    updatedAt: 1,
  };
  const integrity: FidelityReport = {
    importLosses: [],
    exportDowngrades: [],
    integrityWarnings: ["Paragraph count changed"],
    updatedAt: 2,
  };

  it("mounts both announcers empty, then fills only the polite one for a fidelity notice", async () => {
    const ydoc = new Y.Doc();
    const { container } = render(FidelityReportBanner, { props: props(ydoc) });
    const polite = mountedEmpty(container, "fidelity-report-live-polite");
    const assertive = q(container, "fidelity-report-live-assertive");
    expect(assertive?.getAttribute("role")).toBe("alert");
    expect(assertive?.getAttribute("aria-live")).toBe("assertive");
    expect(assertive?.textContent?.trim()).toBe("");

    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FIDELITY_REPORT, losses);
    await tick();

    expect(q(container, "fidelity-report-live-polite")).toBe(polite);
    expect(polite.textContent).toContain("report.docx");
    expect(q(container, "fidelity-report-live-assertive")?.textContent?.trim()).toBe("");
  });

  it("fills only the assertive announcer for an integrity advisory (M5)", async () => {
    const ydoc = new Y.Doc();
    const { container } = render(FidelityReportBanner, { props: props(ydoc) });
    const assertive = q(container, "fidelity-report-live-assertive");

    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FIDELITY_REPORT, integrity);
    await tick();

    expect(q(container, "fidelity-report-live-assertive")).toBe(assertive);
    expect(assertive?.textContent).toContain("may have changed more than expected");
    expect(q(container, "fidelity-report-live-polite")?.textContent?.trim()).toBe("");
  });

  it("never computes role/aria-live from state, and keeps Details reachable", async () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FIDELITY_REPORT, integrity);
    const { container } = render(FidelityReportBanner, { props: props(ydoc) });
    await tick();

    // The banner used to be `role={hasIntegrity ? "alert" : "status"}` — a
    // region whose politeness flipped in the same commit that delivered its
    // text. Both announcers are fixed; the banner owns neither.
    notALiveRegion(q(container, "fidelity-report-banner"));
    expect(
      container.querySelector<HTMLElement>(".tandem-banner__message")?.getAttribute("aria-hidden"),
    ).toBe("true");
    const details = q(container, "fidelity-report-details-toggle");
    expect(details).toBeTruthy();
    expect(details?.closest("[aria-hidden='true']")).toBe(null);
  });
});

describe("SourceView live region", () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const props = (ydoc: Y.Doc) => ({
    documentId: "src-1",
    ydoc,
    onDraftChange: vi.fn(),
    onSave: vi.fn(async () => true),
    onCommandsChange: vi.fn(),
    onExit: vi.fn(),
  });

  it("mounts the announcer before the clear-on-commit warning, then fills that same node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ markdown: "# Source\n" })),
    );
    const ydoc = new Y.Doc();
    const { container } = render(SourceView, { props: props(ydoc) });
    const before = mountedEmpty(container, "source-view-live");
    expect(q(container, "source-view-annotation-warning")).toBeNull();

    ydoc.getMap(Y_MAP_ANNOTATIONS).set("a1", { id: "a1" });
    await waitFor(() => {
      expect(q(container, "source-view-annotation-warning")).toBeTruthy();
    });

    expect(q(container, "source-view-live")).toBe(before);
    expect(before.textContent).toContain("1 annotation");
    // The visible strip holds no controls, so it is safe to hide — and must be,
    // or the sentence is in the a11y tree twice.
    const strip = q(container, "source-view-annotation-warning");
    notALiveRegion(strip);
    expect(strip?.getAttribute("aria-hidden")).toBe("true");
  });

  it("follows a second annotation without replacing the announcer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ markdown: "# Source\n" })),
    );
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATIONS).set("a1", { id: "a1" });
    const { container } = render(SourceView, { props: props(ydoc) });
    await tick();
    const region = q(container, "source-view-live");

    ydoc.getMap(Y_MAP_ANNOTATIONS).set("a2", { id: "a2" });
    await waitFor(() => {
      expect(q(container, "source-view-live")?.textContent).toContain("2 annotations");
    });
    expect(q(container, "source-view-live")).toBe(region);
  });
});
