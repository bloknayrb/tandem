// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import FidelityReportBanner from "../../src/client/components/FidelityReportBanner.svelte";
import { Y_MAP_DOCUMENT_META, Y_MAP_FIDELITY_REPORT } from "../../src/shared/constants.js";
import type { FidelityReport } from "../../src/shared/types.js";

function setReport(ydoc: Y.Doc, report: FidelityReport): void {
  ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FIDELITY_REPORT, report);
}

const baseProps = (ydoc: Y.Doc, fileName = "doc.docx") => ({
  props: { ydoc, documentId: "d1", fileName },
});

describe("FidelityReportBanner", () => {
  it("renders nothing when there is no report", () => {
    const { container } = render(FidelityReportBanner, baseProps(new Y.Doc()));
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeNull();
  });

  it("stays hidden when both loss lists are empty (self-erasing)", async () => {
    const ydoc = new Y.Doc();
    setReport(ydoc, { importLosses: [], exportDowngrades: [], updatedAt: 1 });
    const { container } = render(FidelityReportBanner, baseProps(ydoc));
    await tick();
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeNull();
  });

  it("shows the banner and reveals both groups when Details is toggled", async () => {
    const ydoc = new Y.Doc();
    setReport(ydoc, {
      importLosses: ["Footnotes were not imported"],
      exportDowngrades: ["an image without embedded data (exported as a text placeholder)"],
      updatedAt: 1,
    });
    const { container } = render(FidelityReportBanner, baseProps(ydoc, "report.docx"));
    await tick();

    const banner = container.querySelector("[data-testid='fidelity-report-banner']");
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("report.docx");

    // Collapsed by default.
    expect(container.querySelector("[data-testid='fidelity-report-details']")).toBeNull();

    (
      container.querySelector("[data-testid='fidelity-report-details-toggle']") as HTMLButtonElement
    ).click();
    await tick();

    expect(
      container.querySelector("[data-testid='fidelity-report-import-losses']")?.textContent,
    ).toContain("Footnotes were not imported");
    expect(
      container.querySelector("[data-testid='fidelity-report-export-downgrades']")?.textContent,
    ).toContain("text placeholder");
  });

  it("appears reactively when the report is populated after mount", async () => {
    const ydoc = new Y.Doc();
    const { container } = render(FidelityReportBanner, baseProps(ydoc));
    await tick();
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeNull();

    setReport(ydoc, {
      importLosses: ["Tracked changes were dropped"],
      exportDowngrades: [],
      updatedAt: 2,
    });
    await tick();
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeTruthy();
  });

  it("stays hidden (does not throw) on a malformed/forward-version report shape", async () => {
    // A persisted report from another schema version could be missing an array.
    // Normalize-on-read must keep the `$derived` `.length` access from throwing.
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FIDELITY_REPORT, { updatedAt: 1 } as never);
    const { container } = render(FidelityReportBanner, baseProps(ydoc));
    await tick();
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeNull();
  });

  it("collapses the disclosure when the active doc (ydoc) changes", async () => {
    const docA = new Y.Doc();
    setReport(docA, { importLosses: ["Loss A"], exportDowngrades: [], updatedAt: 1 });
    const { container, rerender } = render(FidelityReportBanner, baseProps(docA, "a.docx"));
    await tick();

    (
      container.querySelector("[data-testid='fidelity-report-details-toggle']") as HTMLButtonElement
    ).click();
    await tick();
    expect(container.querySelector("[data-testid='fidelity-report-details']")).toBeTruthy();

    // Swap to a different document (different tab) that also has losses.
    const docB = new Y.Doc();
    setReport(docB, { importLosses: ["Loss B"], exportDowngrades: [], updatedAt: 2 });
    await rerender({ ydoc: docB, documentId: "d2", fileName: "b.docx" });
    await tick();

    const banner = container.querySelector("[data-testid='fidelity-report-banner']");
    expect(banner?.textContent).toContain("b.docx");
    // Disclosure reset — the left-open panel from doc A must not bleed into doc B.
    expect(container.querySelector("[data-testid='fidelity-report-details']")).toBeNull();
  });

  it("points the integrity advisory at a backup rather than promising one", async () => {
    // The same unverifiable promise the save-anyway hint carries, in the more
    // consequential position: this fires AFTER a save verification already
    // flagged, so it is the sentence a worried user acts on. The backup is
    // best-effort — `snapshotBeforeFirstWrite` returns "skipped-size-cap" past
    // MAX_DOC_BACKUP_BYTES (500 MB) and "failed" on any IO/ACL error, and the
    // save proceeds either way (doc-backup.ts:467).
    const ydoc = new Y.Doc();
    setReport(ydoc, {
      importLosses: [],
      exportDowngrades: [],
      integrityWarnings: ["Paragraph count changed"],
      updatedAt: 1,
    });
    const { container } = render(FidelityReportBanner, baseProps(ydoc, "thesis.docx"));
    await tick();

    const banner = container.querySelector("[data-testid='fidelity-report-banner']");
    // The head clause `live-regions.test.ts` pins must survive the rewording.
    expect(banner?.textContent).toContain("may have changed more than expected");
    expect(banner?.textContent).toMatch(/look for a backup/i);
    // The exact promise that was there before, so a revert to it fails here.
    expect(banner?.textContent).not.toMatch(/your original is backed up/i);
  });
});

/**
 * #1941 — the "Save anyway without pictures" CTA, the only exit a browser user
 * with no Claude attached has from the #1755 save refusal.
 *
 * EVERY case toggles Details first and `tick()`s. The panel lives behind
 * `{#if expanded}`, so an un-toggled absence assertion passes for the wrong
 * reason — which is why each absence case also carries a positive control
 * asserting the panel itself IS rendered.
 */
describe("FidelityReportBanner — save anyway (#1941)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Render, open Details, and hand back the panel + the CTA (or null). */
  async function openDetails(ydoc: Y.Doc, fileName = "doc.docx") {
    const { container } = render(FidelityReportBanner, baseProps(ydoc, fileName));
    await tick();
    const toggle = container.querySelector(
      "[data-testid='fidelity-report-details-toggle']",
    ) as HTMLButtonElement | null;
    toggle?.click();
    await tick();
    return {
      container,
      panel: container.querySelector("[data-testid='fidelity-report-details']"),
      cta: container.querySelector(
        "[data-testid='fidelity-report-save-anyway']",
      ) as HTMLButtonElement | null,
    };
  }

  it("is absent when droppedImages is 0", async () => {
    const ydoc = new Y.Doc();
    setReport(ydoc, {
      importLosses: ["Footnotes were not imported"],
      exportDowngrades: [],
      droppedImages: 0,
      updatedAt: 1,
    });
    const { panel, cta } = await openDetails(ydoc);
    expect(panel, "positive control: the details panel must be open").toBeTruthy();
    expect(cta).toBeNull();
  });

  it("is absent when droppedImages is missing entirely (pre-#1755 report)", async () => {
    const ydoc = new Y.Doc();
    setReport(ydoc, {
      importLosses: ["Footnotes were not imported"],
      exportDowngrades: [],
      updatedAt: 1,
    });
    const { panel, cta } = await openDetails(ydoc);
    expect(panel, "positive control: the details panel must be open").toBeTruthy();
    expect(cta).toBeNull();
  });

  it("renders with the loss stated, once droppedImages > 0", async () => {
    const ydoc = new Y.Doc();
    setReport(ydoc, {
      importLosses: ["2 picture(s) couldn't be imported"],
      exportDowngrades: [],
      droppedImages: 2,
      updatedAt: 1,
    });
    const { panel, cta } = await openDetails(ydoc, "pics.docx");
    expect(cta?.textContent).toMatch(/save anyway without pictures/i);
    // The loss is stated BEFORE the click, in the same panel.
    expect(panel?.textContent).toMatch(/refused by default/i);
    expect(panel?.textContent).toContain("pics.docx");
  });

  it("hedges the backup rather than promising it", async () => {
    // The consent this hint collects is for an IRREVERSIBLE write, so it must
    // not rest on a guarantee the user cannot check. `snapshotBeforeFirstWrite`
    // is best-effort by contract: it returns "skipped-size-cap" once the
    // doc-backups tree reaches MAX_DOC_BACKUP_BYTES (500 MB) and "failed" on any
    // IO/ACL error, and in both cases the destructive save still proceeds —
    // "a snapshot failure must not block the disk write". A user past the cap
    // who reads "your original is backed up" and clicks is then told "No backups
    // exist for this document yet" when they go looking.
    const ydoc = new Y.Doc();
    setReport(ydoc, { importLosses: [], exportDowngrades: [], droppedImages: 1, updatedAt: 1 });
    const { panel } = await openDetails(ydoc);

    expect(panel?.textContent).toMatch(/can't be undone/i);
    expect(panel?.textContent).toMatch(/isn't guaranteed/i);
    // The exact promise that was there before, so a revert to it fails here.
    expect(panel?.textContent).not.toMatch(/your original is backed up and can be/i);
  });

  it("renders for droppedImages > 0 with an EMPTY importLosses", async () => {
    // Reachable and already pinned server-side: the save path takes
    // `importLosses` from a pre-write snapshot while re-reading `droppedImages`
    // off the live doc. A `hasLosses` gate that never consults `droppedImages`
    // hides the whole banner for exactly the report whose next save is refused.
    const ydoc = new Y.Doc();
    setReport(ydoc, { importLosses: [], exportDowngrades: [], droppedImages: 1, updatedAt: 1 });
    const { container, cta } = await openDetails(ydoc);
    expect(container.querySelector("[data-testid='fidelity-report-banner']")).toBeTruthy();
    expect(cta).toBeTruthy();
  });

  it("POSTs allowImageLoss: true when clicked", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { status: "saved" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ydoc = new Y.Doc();
    setReport(ydoc, { importLosses: [], exportDowngrades: [], droppedImages: 1, updatedAt: 1 });
    const { cta } = await openDetails(ydoc);
    cta?.click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      documentId: "d1",
      allowImageLoss: true,
    });
    // `triggerSave` guards on a module-level `inflight` flag that is released in
    // its `finally`. Await the stubbed response so a later spec in this file
    // cannot hit the in-flight early return and silently assert nothing.
    await fetchMock.mock.results[0].value;
    await tick();
  });
});
