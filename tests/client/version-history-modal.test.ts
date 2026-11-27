// @vitest-environment happy-dom

/**
 * VersionHistoryModal (ADR-057 PR 2). Pins the component contract, including
 * the invariants the palette's old confirm flow held (builtin-hardening):
 *  - a malformed listing is "couldn't read", never "no backups exist";
 *  - a genuinely empty listing says so;
 *  - Cancel restores nothing;
 *  - a refused keep (409 BACKUP_FAILED) restores nothing and offers
 *    "Restore anyway", which is the only path that sends discardUnsavedEdits.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import VersionHistoryModal from "../../src/client/components/VersionHistoryModal.svelte";
import { formatBackupAge, formatBackupSize } from "../../src/client/utils/backups.js";
import { API_BACKUPS, API_BACKUPS_RESTORE } from "../../src/shared/api-paths.js";

const MODAL = "[data-testid='version-history-modal']";
const ROW = "[data-testid='version-history-row']";
const RESTORE = "[data-testid='version-history-restore']";
const CONFIRM = "[data-testid='version-history-confirm']";
const CANCEL = "[data-testid='version-history-cancel']";
const ANYWAY = "[data-testid='version-history-restore-anyway']";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Call = { url: string; body: Record<string, unknown> | null };

/** Route fetches by URL; records every call. The restore route is matched first. */
function routes(listing: () => Response, restore?: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      if (url.includes(API_BACKUPS_RESTORE)) {
        return Promise.resolve(restore ? restore(body ?? {}) : json({ data: {} }));
      }
      if (url.includes(API_BACKUPS)) return Promise.resolve(listing());
      return Promise.resolve(json({}, 500));
    }),
  );
  return calls;
}

const TWO = () =>
  json({
    data: {
      backups: [
        { name: "u1-unsaved.md", timestamp: new Date().toISOString(), size: 2048, kind: "unsaved" },
        { name: "d1.md", timestamp: "2026-01-01T00:00:00.000Z", size: 12, kind: "disk" },
      ],
      keptNotice: null,
    },
  });

function open(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onRestored = vi.fn();
  const r = render(VersionHistoryModal, {
    props: {
      documentId: "doc-1",
      fileName: "notes.md",
      onClose,
      onRestored,
      ...overrides,
    },
  });
  return { ...r, onClose, onRestored };
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

describe("VersionHistoryModal", () => {
  it("lists every backup, newest first, labelled by kind", async () => {
    routes(TWO);
    const { container } = open();
    await settle();
    const rows = [...container.querySelectorAll(ROW)];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Your unsaved edits");
    expect(rows[0].textContent).toContain("just now");
    expect(rows[0].textContent).toContain("2.0 KB");
    expect(rows[1].textContent).toContain("File on disk");
    expect(container.querySelector(MODAL)?.textContent).toContain("notes.md");
  });

  it("does NOT report a malformed listing as 'no backups exist'", async () => {
    routes(() => new Response("<html>502", { status: 200 }));
    const { container } = open();
    await settle();
    const text = container.querySelector(MODAL)?.textContent ?? "";
    expect(text).not.toContain("No backups exist");
    expect(text).toContain("Couldn't read");
    expect(container.querySelector("[data-testid='version-history-retry']")).toBeTruthy();
  });

  it("still reports a genuinely empty listing as empty", async () => {
    routes(() => json({ data: { backups: [], keptNotice: null } }));
    const { container } = open();
    await settle();
    expect(container.querySelector("[data-testid='version-history-empty']")?.textContent).toContain(
      "No backups exist",
    );
  });

  it("asks before restoring, and Cancel restores nothing", async () => {
    const calls = routes(TWO);
    const { container } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[1]);
    await settle();
    expect(container.querySelector(CONFIRM)).toBeTruthy();
    await fireEvent.click(container.querySelector(CANCEL)!);
    await settle();
    expect(container.querySelector(CONFIRM)).toBeNull();
    expect(calls.some((c) => c.url.includes(API_BACKUPS_RESTORE))).toBe(false);
  });

  it("restores the chosen version by name, keeping the edits, then reports and closes", async () => {
    const calls = routes(TWO, () =>
      json({ data: { unsavedEditsKept: { name: "k-unsaved.md", timestamp: "x" } } }),
    );
    const { container, onRestored, onClose } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[1]);
    await settle();
    await fireEvent.click(container.querySelector(CONFIRM)!);
    await settle();
    const restore = calls.find((c) => c.url.includes(API_BACKUPS_RESTORE));
    expect(restore?.body).toEqual({ documentId: "doc-1", backup: "d1.md" });
    expect(onRestored).toHaveBeenCalledWith(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("a refused keep restores nothing and offers Restore anyway, the only discard path", async () => {
    let attempt = 0;
    const calls = routes(TWO, () =>
      ++attempt === 1
        ? json(
            { error: "BACKUP_FAILED", message: "The backup folder is full; nothing was restored." },
            409,
          )
        : json({ data: {} }),
    );
    const { container, onRestored } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[1]);
    await settle();
    await fireEvent.click(container.querySelector(CONFIRM)!);
    await settle();

    const error = container.querySelector("[data-testid='version-history-row-error']");
    expect(error?.textContent).toContain("The backup folder is full; nothing was restored.");
    expect(onRestored).not.toHaveBeenCalled();

    await fireEvent.click(container.querySelector(ANYWAY)!);
    await settle();
    const restores = calls.filter((c) => c.url.includes(API_BACKUPS_RESTORE));
    expect(restores[0].body).not.toHaveProperty("discardUnsavedEdits");
    expect(restores[1].body).toEqual({
      documentId: "doc-1",
      backup: "d1.md",
      discardUnsavedEdits: true,
    });
    expect(onRestored).toHaveBeenCalledWith(false);
  });

  it("another failure is shown on its row with no Restore anyway", async () => {
    routes(TWO, () => json({ error: "RELOAD_IN_PROGRESS", message: "busy" }, 409));
    const { container, onClose } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[0]);
    await settle();
    await fireEvent.click(container.querySelector(CONFIRM)!);
    await settle();
    expect(
      container.querySelector("[data-testid='version-history-row-error']")?.textContent,
    ).toContain("busy");
    expect(container.querySelector(ANYWAY)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-reads the list after a failed restore, and shows the error even when its row is gone", async () => {
    let lists = 0;
    routes(
      () => {
        lists++;
        return lists === 1 ? TWO() : json({ data: { backups: [], keptNotice: null } });
      },
      () => json({ error: "FILE_NOT_FOUND", message: "That backup no longer exists." }, 404),
    );
    const { container } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[1]);
    await settle();
    await fireEvent.click(container.querySelector(CONFIRM)!);
    await settle();
    expect(lists).toBe(2);
    expect(container.querySelectorAll(ROW)).toHaveLength(0);
    expect(
      container.querySelector("[data-testid='version-history-row-error']")?.textContent,
    ).toContain("That backup no longer exists.");
  });

  it("Escape closes an open confirm first, then the modal", async () => {
    routes(TWO);
    const { container, onClose } = open();
    await settle();
    await fireEvent.click(container.querySelectorAll(RESTORE)[0]);
    await settle();
    await fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(container.querySelector(CONFIRM)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    routes(TWO);
    const { container } = open({ documentId: null });
    expect(container.querySelector(MODAL)).toBeNull();
  });
});

describe("backups formatting", () => {
  it("ages use the annotation cards' wording", () => {
    expect(formatBackupAge(new Date().toISOString())).toBe("just now");
    expect(formatBackupAge(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatBackupAge("not a date")).toBe("not a date");
    // Past a day: the full date and time, so same-day backups differ.
    const now = Date.parse("2026-06-02T12:00:00Z");
    const a = formatBackupAge("2026-06-01T09:00:00Z", now);
    const c = formatBackupAge("2026-06-01T17:00:00Z", now);
    expect(a).not.toBe(c);
    // The cutoff and the wording read the same clock.
    expect(formatBackupAge("2026-06-02T10:00:00Z", now)).toBe("2h ago");
  });

  it("sizes", () => {
    expect(formatBackupSize(12)).toBe("12 B");
    expect(formatBackupSize(2048)).toBe("2.0 KB");
    expect(formatBackupSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("VersionHistoryModal compare", () => {
  it("compares a backup with the document now, and Back returns to the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/document/compare")) {
          return Promise.resolve(
            json({
              data: {
                current: "now\n",
                other: "then\n",
                otherLabel: "disk-backup",
                truncated: false,
              },
            }),
          );
        }
        return Promise.resolve(TWO());
      }),
    );
    const { container } = open({ canCompare: true });
    await settle();
    await fireEvent.click(container.querySelectorAll("[data-testid='version-history-compare']")[1]);
    await settle();
    expect(container.querySelector("[data-testid='diff-view']")?.textContent).toContain("then");
    expect(container.querySelectorAll(ROW)).toHaveLength(0);
    // Focus stays in the dialog, on the way back.
    const back = container.querySelector<HTMLElement>(
      "[data-testid='version-history-compare-back']",
    );
    expect(document.activeElement).toBe(back);
    await fireEvent.click(back as HTMLElement);
    await settle();
    expect(container.querySelectorAll(ROW)).toHaveLength(2);
    // ... and returns to the row that was compared.
    expect(document.activeElement).toBe(
      container.querySelectorAll("[data-testid='version-history-compare']")[1],
    );
  });

  it("offers no Compare for a document the compare view cannot show", async () => {
    routes(TWO);
    const { container } = open({ canCompare: false });
    await settle();
    expect(container.querySelectorAll(ROW)).toHaveLength(2);
    expect(container.querySelector("[data-testid='version-history-compare']")).toBeNull();
  });

  it("a drag that ends on the backdrop does not close it; a click on the backdrop does", async () => {
    routes(TWO);
    const { container, onClose } = open();
    await settle();
    const backdrop = container.querySelector<HTMLElement>(".modal-backdrop") as HTMLElement;
    const dialog = container.querySelector(MODAL) as HTMLElement;
    await fireEvent.pointerDown(dialog);
    await fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.pointerDown(backdrop);
    await fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });
});
