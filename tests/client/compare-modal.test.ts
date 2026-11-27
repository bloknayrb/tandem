// @vitest-environment happy-dom

/**
 * CompareModal (ADR-057 PR 4): the conflict banner's compare of the file on
 * disk with the document now.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompareModal from "../../src/client/components/CompareModal.svelte";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CompareModal", () => {
  it("Refresh reads the file on disk again", async () => {
    let n = 0;
    const fetchMock = vi.fn(() => {
      n++;
      return Promise.resolve(
        json({
          data: { current: "now\n", other: `disk ${n}\n`, otherLabel: "disk", truncated: false },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(CompareModal, {
      props: { documentId: "doc-1", fileName: "a.md", onClose: vi.fn() },
    });
    await settle();
    expect(container.querySelector("[data-testid='diff-view']")?.textContent).toContain("disk 1");
    await fireEvent.click(
      container.querySelector("[data-testid='compare-refresh']") as HTMLElement,
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='diff-view']")?.textContent).toContain("disk 2");
  });

  it("a drag that ends on the backdrop does not close it; a click on the backdrop does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({ data: { current: "a\n", other: "b\n", otherLabel: "disk", truncated: false } }),
        ),
      ),
    );
    const onClose = vi.fn();
    const { container } = render(CompareModal, {
      props: { documentId: "doc-1", fileName: "a.md", onClose },
    });
    await settle();
    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    const dialog = container.querySelector("[data-testid='compare-modal']") as HTMLElement;
    await fireEvent.pointerDown(dialog);
    await fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.pointerDown(backdrop);
    await fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("never shows the previous comparison when it opens again", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        // The second open's fetch never answers, so only a stale result could show.
        if (calls > 1) return new Promise<Response>(() => {});
        return Promise.resolve(
          json({ data: { current: "a\n", other: "OLD\n", otherLabel: "disk", truncated: false } }),
        );
      }),
    );
    const { container, rerender } = render(CompareModal, {
      props: { documentId: "doc-a", fileName: "a.md", onClose: vi.fn() },
    });
    await settle();
    expect(container.querySelector("[data-testid='diff-view']")?.textContent).toContain("OLD");
    await rerender({ documentId: null, fileName: "", onClose: vi.fn() });
    await settle();
    await rerender({ documentId: "doc-b", fileName: "b.md", onClose: vi.fn() });
    await settle();
    expect(container.querySelector("[data-testid='diff-view']")).toBeNull();
    expect(container.textContent).toContain("Comparing");
  });
});
