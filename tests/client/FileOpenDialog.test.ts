// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileOpenDialog from "../../src/client/components/FileOpenDialog.svelte";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";
import { RECENT_FILES_KEY } from "../../src/shared/constants.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("../../src/client/utils/server-paths.js", () => ({
  openServerPath: vi.fn(),
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
});
