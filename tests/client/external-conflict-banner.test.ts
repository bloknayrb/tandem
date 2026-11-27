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

const baseProps = (
  ydoc: Y.Doc,
  fileName = "notes.md",
  format = "md",
  { source = "file", readOnly = false }: { source?: string; readOnly?: boolean } = {},
) => ({
  props: { ydoc, documentId: "d1", fileName, format, source, readOnly },
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
    // ADR-057 PR 3: both choices are undoable here.
    expect(banner?.textContent).toContain("kept in Version history first");
    expect(banner?.textContent).toContain("reloading keeps your unsaved edits in Version history");
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

  it("does not inherit stale pending/error state when a NEW conflict replaces the old one directly (no null in between)", async () => {
    // Regression for a same-document race the `forDoc`/`{#key}` guards don't
    // cover: a slow resolve() for conflict A is still in flight when the
    // server clears A and raises conflict B WITHOUT an intermediate `delete`
    // (e.g. two Y.Map writes coalesced into one observer callback). Before the
    // fix, `read()` only reset `error` on the null transition and never reset
    // `pending` at all, so B's banner would render with A's leftover
    // "Keeping…"/disabled buttons, and A's eventual failure could attach to B.
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();

    let releaseFetch: (() => void) | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise((_resolve, reject) => {
        releaseFetch = () => reject(new Error("offline"));
      })) as typeof fetch;

    try {
      (
        container.querySelector("[data-testid='external-conflict-keep-btn']") as HTMLButtonElement
      ).click();
      await tick();
      // A's resolve is in flight: buttons disabled, "Keeping…" showing.
      expect(
        (container.querySelector("[data-testid='external-conflict-keep-btn']") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(container.querySelector(BANNER)?.textContent).toContain("Keeping…");

      // Server replaces A with a fresh conflict B on the SAME document, in one
      // write — no delete, no null transition.
      setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 2 });
      await tick();

      // B's banner must NOT inherit A's stale pending state.
      expect(
        (container.querySelector("[data-testid='external-conflict-keep-btn']") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(container.querySelector(BANNER)?.textContent).not.toContain("Keeping…");
      expect(container.querySelector(BANNER)?.textContent).not.toContain(
        "Could not reach the server",
      );

      // A's stale request now settles (fails). It must not retroactively
      // disable B's buttons or attach its error to B's banner.
      releaseFetch?.();
      await tick();
      await Promise.resolve();
      await tick();

      expect(container.querySelector(BANNER)?.textContent).not.toContain(
        "Could not reach the server",
      );
      expect(
        (container.querySelector("[data-testid='external-conflict-keep-btn']") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never promises Reload keeps the edits where the server keeps none (read-only, .docx, upload)", async () => {
    for (const [name, format, opts] of [
      ["ro.md", "md", { readOnly: true }],
      ["doc.docx", "docx", {}],
      ["up.md", "md", { source: "upload" }],
    ] as const) {
      const ydoc = new Y.Doc();
      setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 1 });
      const { container, unmount } = render(
        ExternalConflictBanner,
        baseProps(ydoc, name, format, opts),
      );
      await tick();
      const text = container.querySelector(BANNER)?.textContent ?? "";
      expect(text, name).toMatch(/reloading discards (your unsaved edits|them)/);
      expect(text, name).not.toContain("reloading keeps");
      unmount();
    }
  });

  it("names Version history for a restored session's Reload on a writable .md", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "unsaved-restore", diskChanged: false, detectedAt: 4 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();
    expect(container.querySelector(BANNER)?.textContent).toContain(
      "they're kept in Version history",
    );
  });

  it("offers Reload anyway only after a refused keep, for that conflict, and sends the flag with the same episode", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 7 });
    const { container } = render(ExternalConflictBanner, baseProps(ydoc));
    await tick();
    const ANYWAY = "[data-testid='external-conflict-reload-anyway-btn']";
    expect(container.querySelector(ANYWAY)).toBeNull();

    const bodies: unknown[] = [];
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call++;
      return Promise.resolve(
        call === 1
          ? new Response(JSON.stringify({ error: "BACKUP_FAILED", message: "No room." }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
      );
    }) as typeof fetch;
    try {
      (
        container.querySelector("[data-testid='external-conflict-reload-btn']") as HTMLButtonElement
      ).click();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        await tick();
      }
      expect(container.querySelector(BANNER)?.textContent).toContain("No room.");
      const anyway = container.querySelector(ANYWAY) as HTMLButtonElement;
      expect(anyway).toBeTruthy();
      anyway.click();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        await tick();
      }
      expect(bodies).toEqual([
        { documentId: "d1", choice: "reload", detectedAt: 7 },
        { documentId: "d1", choice: "reload", detectedAt: 7, discardUnsavedEdits: true },
      ]);

      // A newer conflict does not inherit the offer.
      setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 8 });
      await tick();
      expect(container.querySelector(ANYWAY)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("offers Compare for a .md file and calls back with its document", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 9 });
    const calls: string[] = [];
    const { container } = render(ExternalConflictBanner, {
      props: { ...baseProps(ydoc).props, onCompare: (id: string) => calls.push(id) },
    });
    await tick();
    (
      container.querySelector("[data-testid='external-conflict-compare-btn']") as HTMLButtonElement
    ).click();
    expect(calls).toEqual(["d1"]);
  });

  it("offers no Compare for a format without plain text on both sides", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 9 });
    const { container } = render(ExternalConflictBanner, {
      props: { ...baseProps(ydoc, "page.html", "html").props, onCompare: () => {} },
    });
    await tick();
    expect(container.querySelector("[data-testid='external-conflict-compare-btn']")).toBeNull();
  });

  it("offers no Compare for a read-only document, which is never saved", async () => {
    const ydoc = new Y.Doc();
    setConflict(ydoc, { kind: "external-edit", diskChanged: true, detectedAt: 9 });
    const { container } = render(ExternalConflictBanner, {
      props: { ...baseProps(ydoc).props, readOnly: true, onCompare: () => {} },
    });
    await tick();
    expect(container.querySelector("[data-testid='external-conflict-compare-btn']")).toBeNull();
  });
});
