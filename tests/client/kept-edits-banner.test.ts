// @vitest-environment happy-dom

/**
 * KeptEditsBanner (ADR-057 PR 2). Pins the component contract: it renders off
 * `GET /api/backups`' `keptNotice` alone, re-reads on every revision bump with
 * the latest request winning, stays silent when the read fails, Dismiss
 * acknowledges exactly the names it showed, and View opens the history for
 * its own document.
 *
 * Covers the component, not the App.svelte mount site.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import KeptEditsBanner from "../../src/client/components/KeptEditsBanner.svelte";
import { bumpBackupsRevision } from "../../src/client/hooks/backupsRevision.svelte.js";
import { API_BACKUPS, API_BACKUPS_ACKNOWLEDGE } from "../../src/shared/api-paths.js";

const BANNER = "[data-testid='kept-edits-banner']";
const VIEW = "[data-testid='kept-edits-banner-view']";
const DISMISS = "[data-testid='kept-edits-banner-dismiss']";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOTICE = {
  timestamp: "2026-06-01T12:00:00.000Z",
  names: ["n2-unsaved.md", "n1-unsaved.md"],
};

function listing(keptNotice: unknown) {
  return json({ data: { backups: [], keptNotice } });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
}

function mount(onOpenHistory = vi.fn()) {
  const r = render(KeptEditsBanner, {
    props: { documentId: "doc-1", fileName: "notes.md", onOpenHistory },
  });
  return { ...r, onOpenHistory };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KeptEditsBanner", () => {
  it("renders nothing when there is no notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listing(null)),
    );
    const { container } = mount();
    await settle();
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("shows the notice for its document and opens the history for it", async () => {
    const fetchMock = vi.fn(async (_url: string) => listing(NOTICE));
    vi.stubGlobal("fetch", fetchMock);
    const { container, onOpenHistory } = mount();
    await settle();
    expect(fetchMock.mock.calls[0][0]).toContain(`${API_BACKUPS}?documentId=doc-1`);
    expect(container.querySelector(BANNER)?.textContent).toContain("notes.md");
    await fireEvent.click(container.querySelector(VIEW)!);
    expect(onOpenHistory).toHaveBeenCalledWith("doc-1");
  });

  it("stays silent when the read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "boom" }, 500)),
    );
    const { container } = mount();
    await settle();
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("Dismiss acknowledges exactly the names shown, then re-reads", async () => {
    let acked = false;
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes(API_BACKUPS_ACKNOWLEDGE)) {
          bodies.push(JSON.parse(String(init?.body)));
          acked = true;
          return json({ data: { acknowledged: true } });
        }
        return listing(acked ? null : NOTICE);
      }),
    );
    const { container } = mount();
    await settle();
    await fireEvent.click(container.querySelector(DISMISS)!);
    await settle();
    expect(bodies).toEqual([{ documentId: "doc-1", backups: NOTICE.names }]);
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it("a failed Dismiss keeps the banner and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes(API_BACKUPS_ACKNOWLEDGE) ? json({}, 500) : listing(NOTICE),
      ),
    );
    const { container } = mount();
    await settle();
    await fireEvent.click(container.querySelector(DISMISS)!);
    await settle();
    expect(container.querySelector(BANNER)?.textContent).toContain("Couldn't dismiss");
  });

  it("the latest read wins: a slow earlier answer cannot bring the banner back", async () => {
    let resolveFirst: (r: Response) => void = () => {};
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++;
        if (call === 1) return new Promise<Response>((r) => (resolveFirst = r));
        return Promise.resolve(listing(null));
      }),
    );
    const { container } = mount();
    await settle();
    bumpBackupsRevision();
    await settle();
    resolveFirst(listing(NOTICE));
    await settle();
    expect(container.querySelector(BANNER)).toBeNull();
  });
});
