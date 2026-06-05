// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browseNativeFile,
  openFileForRuntime,
  pickNativeFilePath,
} from "../../src/client/utils/browse-file.js";
import * as defaultDir from "../../src/client/utils/default-directory.js";
import { loadRecentFiles } from "../../src/client/utils/recentFiles.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";
import { RECENT_FILES_KEY } from "../../src/shared/constants.js";

vi.mock("../../src/client/utils/server-paths.js", () => ({
  openServerPath: vi.fn(),
}));

vi.mock("../../src/client/utils/default-directory.js", () => ({
  resolveDefaultDirectory: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("browseNativeFile (Tauri native picker)", () => {
  beforeEach(() => {
    vi.mocked(serverPaths.openServerPath).mockReset();
    try {
      window.localStorage.removeItem(RECENT_FILES_KEY);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: picks a file, opens it, and records it as recent", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("C:/path/to/file.md");
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({ ok: true });
    const onError = vi.fn();

    await browseNativeFile({ onError });

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
    expect(loadRecentFiles()).toContainEqual(
      expect.objectContaining({ path: "C:/path/to/file.md" }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("cancel (null): no open, no recent write, no error", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(null);
    const onError = vi.fn();

    await browseNativeFile({ onError });

    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
    expect(loadRecentFiles()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("open failure: surfaces the error and does not record a recent file", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("C:/path/to/file.md");
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({
      ok: false,
      error: "File not found.",
    });
    const onError = vi.fn();

    await browseNativeFile({ onError });

    expect(onError).toHaveBeenCalledWith("File not found.");
    expect(loadRecentFiles()).toEqual([]);
  });

  it("dialog plugin throws: surfaces a 'File picker unavailable' error", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockRejectedValue(new Error("plugin missing"));
    const onError = vi.fn();

    await browseNativeFile({ onError });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("File picker unavailable"));
    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
  });
});

describe("openFileForRuntime (runtime branch)", () => {
  beforeEach(() => {
    vi.mocked(serverPaths.openServerPath).mockReset();
    try {
      window.localStorage.removeItem(RECENT_FILES_KEY);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Tauri branch: calls the native picker, does not open the modal", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(null);
    const openModal = vi.fn();

    await openFileForRuntime({ isTauri: true, openModal });

    expect(vi.mocked(open)).toHaveBeenCalledOnce();
    expect(openModal).not.toHaveBeenCalled();
  });

  it("browser branch: opens the modal, does not call the native picker", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const openModal = vi.fn();

    await openFileForRuntime({ isTauri: false, openModal });

    expect(openModal).toHaveBeenCalledOnce();
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });
});

describe("pickNativeFilePath defaultPath (#1023)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(defaultDir.resolveDefaultDirectory).mockResolvedValue(null);
  });

  it("passes the resolved smart-default directory as the dialog defaultPath", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("/home/me/notes/x.md");
    vi.mocked(defaultDir.resolveDefaultDirectory).mockResolvedValue("/home/me/notes");

    await pickNativeFilePath();

    expect(vi.mocked(open)).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/home/me/notes" }),
    );
  });

  it("passes defaultPath: undefined when no directory tier resolves", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(defaultDir.resolveDefaultDirectory).mockResolvedValue(null);

    await pickNativeFilePath();

    expect(vi.mocked(open)).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: undefined }),
    );
  });
});
