// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileOpenDialog from "../../src/client/components/FileOpenDialog.svelte";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";
import {
  API_SESSIONS,
  API_SESSIONS_CLEAR,
  API_SESSIONS_DELETE,
} from "../../src/shared/api-paths.js";
import { RECENT_FILES_KEY } from "../../src/shared/constants.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("../../src/client/utils/server-paths.js", () => ({
  openServerPath: vi.fn(),
}));

vi.mock("../../src/client/utils/default-directory.js", () => ({
  resolveDefaultDirectory: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../../src/client/utils/fileUpload.js", () => ({
  API_BASE: "",
  readFileForUpload: vi.fn(async () => "file-contents"),
}));

describe("FileOpenDialog unified (#378)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    vi.mocked(serverPaths.openServerPath).mockReset();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      window.localStorage.removeItem(RECENT_FILES_KEY);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  it("renders a single Browse button (no tab toggle, no path input)", () => {
    const { queryByTestId, getByTestId } = render(FileOpenDialog, {
      props: { onClose: vi.fn() },
    });
    expect(getByTestId("file-open-browse")).toBeTruthy();
    // PR #808 testids that are intentionally gone after consolidation.
    expect(queryByTestId("file-path-input")).toBeNull();
    expect(queryByTestId("file-open-submit")).toBeNull();
    expect(queryByTestId("file-upload-zone")).toBeNull();
  });

  it("browser runtime: Browse triggers the hidden file input and uploads on change", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const onClose = vi.fn();
    const { getByTestId, container } = render(FileOpenDialog, { props: { onClose } });

    const hiddenInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(hiddenInput).toBeTruthy();
    const clickSpy = vi.spyOn(hiddenInput, "click");

    await fireEvent.click(getByTestId("file-open-browse"));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const file = new File(["hi"], "x.md", { type: "text/markdown" });
    Object.defineProperty(hiddenInput, "files", { value: [file], configurable: true });
    await fireEvent.change(hiddenInput);
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/upload");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tauri runtime: Browse calls plugin-dialog and opens path editable", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("C:/path/to/file.md");
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({ ok: true });

    const onClose = vi.fn();
    const { getByTestId } = render(FileOpenDialog, { props: { onClose } });
    await fireEvent.click(getByTestId("file-open-browse"));
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(open)).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        directory: false,
        filters: [
          expect.objectContaining({
            name: "Documents",
            extensions: expect.arrayContaining(["md", "txt", "html", "htm", "docx"]),
          }),
        ],
      }),
    );
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/path/to/file.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tauri runtime: cancel (null) is a no-op — no openServerPath, no onClose, no error", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(null);

    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(FileOpenDialog, { props: { onClose } });
    await fireEvent.click(getByTestId("file-open-browse"));
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(queryByTestId("file-open-error")).toBeNull();
  });

  it("Recent file click routes through openServerPath (regression guard)", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({ ok: true });
    const past = "C:/notes/old.md";
    try {
      window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify([past]));
    } catch {
      // happy-dom may not have storage; the dialog itself handles that.
    }

    const onClose = vi.fn();
    const { findByTestId } = render(FileOpenDialog, { props: { onClose } });
    const recent = await findByTestId("recent-file-0");
    await fireEvent.click(recent);
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith(past);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the drop-anywhere hint only in Tauri runtime", () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const browser = render(FileOpenDialog, { props: { onClose: vi.fn() } });
    expect(browser.container.textContent).not.toContain("drop a file anywhere");
    cleanup();

    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const tauri = render(FileOpenDialog, { props: { onClose: vi.fn() } });
    expect(tauri.container.textContent).toContain("drop a file anywhere");
  });

  // #1773 — the per-session × and "Clear all" used to call the delete route on
  // the first click, with no confirmation, undo or toast. Both now arm first.
  //
  // Nested INSIDE the outer describe on purpose: its beforeEach/afterEach carry
  // the fetch stub, the RECENT_FILES_KEY clear, the isTauriRuntime reset and
  // cleanup(). A sibling describe would inherit none of them.
  describe("saved-session delete confirmations (#1773)", () => {
    const ROWS = [
      { filePath: "C:/notes/one.md", lastAccessed: Date.now(), annotationCount: 3 },
      { filePath: "C:/notes/two.md", lastAccessed: Date.now(), annotationCount: 1 },
    ];

    beforeEach(() => {
      // Mutate the mock the OUTER beforeEach already installed via
      // vi.stubGlobal — that call captured the function VALUE, so reassigning
      // the `fetchMock` variable would leave globalThis.fetch on the outer
      // {ok:true, json:()=>({})}. fetchSessions would then read
      // json.data?.sessions ?? [] → [], the dialog would render sessions-empty
      // with zero rows, and case (a)'s "no delete call" assertion would be
      // checked against a never-installed, never-called mock: green on any build.
      fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
        const href = String(url);
        // Branch on the POST routes BEFORE the bare list route: api-paths.ts
        // makes "/api/sessions" a strict prefix of both, and this file mocks
        // API_BASE to "", so a leading list branch swallows the POSTs.
        if (href.includes(API_SESSIONS_DELETE) || href.includes(API_SESSIONS_CLEAR)) {
          return { ok: true, json: async () => ({ data: {} }) };
        }
        if (href.includes(API_SESSIONS) && init?.method !== "POST") {
          return { ok: true, json: async () => ({ data: { sessions: ROWS } }) };
        }
        return { ok: true, json: async () => ({}) };
      });
    });

    /** Render, expand the sessions list, and settle the fetch. */
    async function renderExpanded() {
      const utils = render(FileOpenDialog, { props: { onClose: vi.fn() } });
      await fireEvent.click(utils.getByTestId("sessions-toggle"));
      await tick();
      await new Promise((r) => setTimeout(r, 0));
      await tick();
      return utils;
    }

    const callsTo = (apiPath: string) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes(apiPath));

    it("(a) the row × only arms — the delete fires on the confirm", async () => {
      const { getAllByTestId, getByTestId } = await renderExpanded();
      expect(getAllByTestId("session-row")).toHaveLength(2);

      await fireEvent.click(getAllByTestId("session-delete")[0]);
      await tick();

      // The discriminating assertion: a confirm affordance that still fires the
      // request on the first click is exactly the bug.
      expect(callsTo(API_SESSIONS_DELETE)).toHaveLength(0);
      expect(getAllByTestId("session-row")).toHaveLength(2);

      await fireEvent.click(getByTestId("session-delete-confirm"));
      await tick();
      await new Promise((r) => setTimeout(r, 0));
      await tick();

      const deletes = callsTo(API_SESSIONS_DELETE);
      expect(deletes).toHaveLength(1);
      expect(JSON.parse(String((deletes[0][1] as { body: string }).body))).toEqual({
        filePath: ROWS[0].filePath,
      });
      expect(getAllByTestId("session-row")).toHaveLength(1);
    });

    it("(b) Cancel disarms without deleting", async () => {
      const { getAllByTestId, getByTestId } = await renderExpanded();
      await fireEvent.click(getAllByTestId("session-delete")[0]);
      await tick();
      await fireEvent.click(getByTestId("session-delete-cancel"));
      await tick();
      await new Promise((r) => setTimeout(r, 0));

      expect(callsTo(API_SESSIONS_DELETE)).toHaveLength(0);
      expect(getAllByTestId("session-row")).toHaveLength(2);
      expect(getAllByTestId("session-delete")).toHaveLength(2);
    });

    it("(c) arming one row leaves the other row unarmed", async () => {
      const { getAllByTestId, getByTestId } = await renderExpanded();
      await fireEvent.click(getAllByTestId("session-delete")[0]);
      await tick();

      // Arming row 1 replaced its ×, so exactly one session-delete remains —
      // which is also why this is a containment check and not an index lookup:
      // after arming row 1 there is no index 1 to take.
      expect(getAllByTestId("session-delete")).toHaveLength(1);
      const confirms = getAllByTestId("session-delete-confirm");
      expect(confirms).toHaveLength(1);
      expect(getAllByTestId("session-row")[0].contains(confirms[0])).toBe(true);
      expect(getAllByTestId("session-row")[1].contains(getByTestId("session-delete"))).toBe(true);
    });

    it("(d) Clear all only arms — the clear fires on the confirm", async () => {
      const { getAllByTestId, getByTestId, queryByTestId } = await renderExpanded();
      await fireEvent.click(getByTestId("sessions-clear-all"));
      await tick();

      expect(callsTo(API_SESSIONS_CLEAR)).toHaveLength(0);
      expect(getAllByTestId("session-row")).toHaveLength(2);

      await fireEvent.click(getByTestId("sessions-clear-all-confirm"));
      await tick();
      await new Promise((r) => setTimeout(r, 0));
      await tick();

      expect(callsTo(API_SESSIONS_CLEAR)).toHaveLength(1);
      expect(queryByTestId("session-row")).toBeNull();
      expect(getByTestId("sessions-empty")).toBeTruthy();
    });

    // Its own `it`: after a successful Clear all the whole non-empty branch is
    // gone, and cleanup() runs only in the file's afterEach — so a second
    // render() in the same `it` leaves two dialogs mounted and every
    // getByTestId throws on multiple matches.
    it("(d2) Clear all cancel disarms without clearing", async () => {
      const { getAllByTestId, getByTestId } = await renderExpanded();
      await fireEvent.click(getByTestId("sessions-clear-all"));
      await tick();
      await fireEvent.click(getByTestId("sessions-clear-all-cancel"));
      await tick();
      await new Promise((r) => setTimeout(r, 0));

      expect(callsTo(API_SESSIONS_CLEAR)).toHaveLength(0);
      expect(getAllByTestId("session-row")).toHaveLength(2);
      expect(getByTestId("sessions-clear-all")).toBeTruthy();
    });

    it("(e) the two confirms are independent — arming Clear all disarms the row", async () => {
      const { getAllByTestId, getByTestId, queryByTestId } = await renderExpanded();
      await fireEvent.click(getAllByTestId("session-delete")[0]);
      await tick();
      await fireEvent.click(getByTestId("sessions-clear-all"));
      await tick();

      expect(queryByTestId("session-delete-confirm")).toBeNull();
      expect(getByTestId("sessions-clear-all-confirm")).toBeTruthy();
      expect(getAllByTestId("session-delete")).toHaveLength(2);
    });

    it("(f) collapsing the list disarms", async () => {
      const { getAllByTestId, getByTestId, queryByTestId } = await renderExpanded();
      await fireEvent.click(getAllByTestId("session-delete")[0]);
      await tick();

      await fireEvent.click(getByTestId("sessions-toggle"));
      await tick();
      await fireEvent.click(getByTestId("sessions-toggle"));
      await tick();

      expect(queryByTestId("session-delete-confirm")).toBeNull();
      expect(getAllByTestId("session-delete")).toHaveLength(2);
    });
  });
});
