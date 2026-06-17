// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
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
});
