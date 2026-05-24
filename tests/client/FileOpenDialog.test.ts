// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileOpenDialog from "../../src/client/components/FileOpenDialog.svelte";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";

// The dialog opens in "upload" mode by default (#478). Switch to the
// "File Path" tab so the Tauri-only Browse button is renderable.
async function switchToPathTab(container: HTMLElement) {
  const tab = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "File Path",
  );
  if (!tab) throw new Error("File Path tab not found");
  await fireEvent.click(tab);
  await tick();
}

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("../../src/client/utils/server-paths.js", () => ({
  openServerPath: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("FileOpenDialog Browse button (#378)", () => {
  beforeEach(() => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    vi.mocked(serverPaths.openServerPath).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  it("hides the Browse button in browser runtime", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const { queryByTestId, container } = render(FileOpenDialog, {
      props: { onClose: vi.fn() },
    });
    await switchToPathTab(container);
    expect(queryByTestId("file-open-browse")).toBeNull();
    // Sibling Open button is still present, so the path tab did render.
    expect(queryByTestId("file-open-submit")).not.toBeNull();
  });

  it("shows Browse, picks a file, and opens it via openServerPath", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("C:/path/to/file.md");
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({ ok: true });

    const onClose = vi.fn();
    const { getByTestId, container } = render(FileOpenDialog, { props: { onClose } });
    await switchToPathTab(container);
    const browse = getByTestId("file-open-browse");
    await fireEvent.click(browse);
    await tick();
    // Flush the awaited dynamic-import + openByPath chain.
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(open)).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        directory: false,
        filters: [
          expect.objectContaining({
            name: "Documents",
            extensions: ["md", "txt", "html", "htm", "docx"],
          }),
        ],
      }),
    );
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/path/to/file.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the user cancels (open resolves null)", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(null);

    const onClose = vi.fn();
    const { getByTestId, queryByTestId, container } = render(FileOpenDialog, {
      props: { onClose },
    });
    await switchToPathTab(container);
    await fireEvent.click(getByTestId("file-open-browse"));
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(queryByTestId("file-open-error")).toBeNull();
  });
});
