// @vitest-environment happy-dom

/**
 * ExternalConflictBanner (#1069; every format since #1238).
 *
 * The docx gate was never in this component — it was one level up, in
 * App.svelte's `{#if activeTab && activeTab.format === "docx"}` around the
 * mount. These cases pin the component contract that made un-gating safe: it
 * renders off the Y.Map flag alone, disappears when the server clears it, keeps
 * no residue across a document swap, and only promises a save for a format that
 * has one.
 *
 * Scope note: this covers the component, NOT the App.svelte mount site (the
 * `{#key}`, the source-view suppression, the format prop wiring). That gate has
 * no unit coverage and is verified manually.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import ExternalConflictBanner from "../../src/client/components/ExternalConflictBanner.svelte";
import { Y_MAP_DOCUMENT_META, Y_MAP_EXTERNAL_CONFLICT } from "../../src/shared/constants.js";
import type { ExternalConflictState } from "../../src/shared/types.js";

const BANNER = "[data-testid='external-conflict-banner']";

function setConflict(ydoc: Y.Doc, conflict: ExternalConflictState): void {
  ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, conflict);
}

const baseProps = (ydoc: Y.Doc, fileName = "notes.md", format = "md") => ({
  props: { ydoc, documentId: "d1", fileName, format },
});

describe("ExternalConflictBanner", () => {
  it("renders nothing when no conflict is pending", () => {
    const { container } = render(ExternalConflictBanner, baseProps(new Y.Doc()));
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("renders an external-edit conflict for a .md document", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();

    const banner = container.querySelector(BANNER);
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("notes.md");
    expect(banner?.textContent).toContain("your next save overwrites the disk changes");
    expect(container.querySelector("[data-testid='external-conflict-keep-btn']")).toBeTruthy();
    expect(container.querySelector("[data-testid='external-conflict-reload-btn']")).toBeTruthy();
  });

  it("does not promise a save for a format that has none", async () => {
    // .html is in neither AUTO_SAVE_FORMATS nor BINARY_SAVE_FORMATS, so the
    // server refuses every save for it. The default copy ("your next save
    // overwrites the disk changes") would describe something that cannot
    // happen — keeping edits there keeps them in the session only.
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc, "page.html", "html"));
    await tick();

    const text = container.querySelector(BANNER)?.textContent ?? "";
    expect(text).toContain("can't write this file type back to disk");
    expect(text).not.toContain("your next save overwrites the disk changes");
  });

  it("keeps no residue when the document swaps under it", async () => {
    // App.svelte remounts per tab, but the component accepts a swappable ydoc
    // and every resolve() write happens after an await — so the contract has to
    // hold on its own.
    const a = new Y.Doc();
    const b = new Y.Doc();
    setConflict(a, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
    const { container, rerender } = render(ExternalConflictBanner, baseProps(a, "a.md"));
    await tick();
    expect(container.querySelector(BANNER)).toBeTruthy();

    await rerender({ ydoc: b, documentId: "d2", fileName: "b.md", format: "md" });
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();

    // The old document's observer must be gone, not merely ignored.
    setConflict(a, { kind: "external-edit", diskChanged: true, detectedAt: 9 });
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();

    // …and the new document's own flag must still be picked up.
    setConflict(b, { kind: "unsaved-restore", diskChanged: true, detectedAt: 10 });
    await tick();
    expect(container.querySelector(BANNER)?.textContent).toContain("b.md");
  });

  it("appears reactively when the server flags a conflict after mount", async () => {
    const ydoc = new Y.Doc();
    const { container } = render(ExternalConflictBanner, baseProps(ydoc, "draft.txt"));
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();

    setConflict(ydoc, { kind: "unsaved-restore", diskChanged: false, detectedAt: 2 });
    await tick();
    expect(container.querySelector(BANNER)?.textContent).toContain("draft.txt");
  });

  it("disappears when the server clears the flag", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 3 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();
    expect(container.querySelector(BANNER)).toBeTruthy();

    // What a successful resolve / reload / save does server-side. The banner is
    // server-authoritative, so this is the only way it goes away.
    ydoc.getMap(Y_MAP_DOCUMENT_META).delete(Y_MAP_EXTERNAL_CONFLICT);
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("does not carry a failed resolve's message into the next conflict", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();

    // Fail a resolve, then let the server clear the flag some other way (a
    // save, or the user resolving from elsewhere).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    try {
      (
        container.querySelector("[data-testid='external-conflict-keep-btn']") as HTMLButtonElement
      ).click();
      await tick();
      await Promise.resolve();
      await tick();
      expect(container.querySelector(BANNER)?.textContent).toContain("Could not reach the server");
    } finally {
      globalThis.fetch = originalFetch;
    }

    ydoc.getMap(Y_MAP_DOCUMENT_META).delete(Y_MAP_EXTERNAL_CONFLICT);
    await tick();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 2 });
    await tick();

    // The new banner is about a new conflict — the old failure must not ride along.
    expect(container.querySelector(BANNER)?.textContent).not.toContain(
      "Could not reach the server",
    );
  });
});
