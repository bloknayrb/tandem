// @vitest-environment happy-dom

/**
 * ReadOnlyFileBanner (#2273). Pins the component contract: it renders off the
 * Y.Map mirror alone, hides once declined, offers Overwrite only where the
 * server says it can (never on Windows), answers with the exact episode it
 * showed, and reports a save that still did not land.
 *
 * Covers the component, not the App.svelte mount site.
 */

import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import ReadOnlyFileBanner from "../../src/client/components/ReadOnlyFileBanner.svelte";
import { API_READ_ONLY_FILE_RESOLVE } from "../../src/shared/api-paths.js";
import { Y_MAP_DOCUMENT_META, Y_MAP_READ_ONLY_FILE } from "../../src/shared/constants.js";
import type { ReadOnlyFileState } from "../../src/shared/types.js";

const BANNER = "[data-testid='read-only-file-banner']";
const OVERWRITE = "[data-testid='read-only-file-overwrite-btn']";
const DISMISS = "[data-testid='read-only-file-dismiss-btn']";

function setPrompt(ydoc: Y.Doc, state: ReadOnlyFileState): void {
  ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_READ_ONLY_FILE, state);
}

const props = (ydoc: Y.Doc) => ({ props: { ydoc, documentId: "d1", fileName: "locked.md" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReadOnlyFileBanner", () => {
  it("renders nothing without a prompt", () => {
    const { container } = render(ReadOnlyFileBanner, props(new Y.Doc()));
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("offers Overwrite and Not now where the server can overwrite", async () => {
    const ydoc = new Y.Doc();
    setPrompt(ydoc, { detectedAt: 5, declined: false, canOverwrite: true });
    const { container } = render(ReadOnlyFileBanner, props(ydoc));
    await tick();
    expect(container.querySelector(BANNER)?.textContent).toContain("locked.md is read-only");
    expect(container.querySelector(OVERWRITE)).toBeTruthy();
    expect(container.querySelector(DISMISS)).toBeTruthy();
  });

  it("offers no Overwrite on Windows and names the Properties checkbox", async () => {
    const ydoc = new Y.Doc();
    setPrompt(ydoc, { detectedAt: 5, declined: false, canOverwrite: false });
    const { container } = render(ReadOnlyFileBanner, props(ydoc));
    await tick();
    expect(container.querySelector(OVERWRITE)).toBeNull();
    expect(container.querySelector(BANNER)?.textContent).toContain("Properties");
  });

  it("hides once declined, and disappears when the server clears the prompt", async () => {
    const ydoc = new Y.Doc();
    setPrompt(ydoc, { detectedAt: 5, declined: false, canOverwrite: true });
    const { container } = render(ReadOnlyFileBanner, props(ydoc));
    await tick();
    expect(container.querySelector(BANNER)).toBeTruthy();
    setPrompt(ydoc, { detectedAt: 5, declined: true, canOverwrite: true });
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();
    setPrompt(ydoc, { detectedAt: 6, declined: false, canOverwrite: true });
    await tick();
    expect(container.querySelector(BANNER)).toBeTruthy();
    ydoc.getMap(Y_MAP_DOCUMENT_META).delete(Y_MAP_READ_ONLY_FILE);
    await tick();
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("answers with the document and the exact episode it showed", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { outcome: "approved", save: { status: "saved" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ydoc = new Y.Doc();
    setPrompt(ydoc, { detectedAt: 77, declined: false, canOverwrite: true });
    const { container } = render(ReadOnlyFileBanner, props(ydoc));
    await tick();
    await fireEvent.click(container.querySelector(OVERWRITE)!);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(API_READ_ONLY_FILE_RESOLVE);
    expect(JSON.parse(String(init.body))).toEqual({
      documentId: "d1",
      choice: "overwrite",
      detectedAt: 77,
    });
  });

  it("says why when the approved save still did not land", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { outcome: "approved", save: { status: "skipped", skipCode: "FILE_MODIFIED" } },
        }),
      })),
    );
    const ydoc = new Y.Doc();
    setPrompt(ydoc, { detectedAt: 9, declined: false, canOverwrite: true });
    const { container } = render(ReadOnlyFileBanner, props(ydoc));
    await tick();
    await fireEvent.click(container.querySelector(OVERWRITE)!);
    await vi.waitFor(() =>
      expect(container.querySelector(BANNER)?.textContent).toContain("changed on disk"),
    );
  });
});
