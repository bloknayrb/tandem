import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import { createFileDrop } from "../../src/client/hooks/useFileDrop.svelte.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("../../src/client/utils/fileUpload.js", () => ({
  API_BASE: "",
  readFileForUpload: vi.fn(async () => "file-contents"),
}));

function makeDropEvent(files: File[]): DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      files,
      types: ["Files"],
    },
  } as unknown as DragEvent;
}

describe("useFileDrop (browser-only handler)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads dropped file in browser runtime", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const drop = createFileDrop();
    const file = new File(["hello"], "x.md", { type: "text/markdown" });
    await drop.handleEditorDrop(makeDropEvent([file]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/upload");
    expect(init.method).toBe("POST");
  });

  it("early-returns in Tauri runtime — no upload, native handler owns the drop", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const drop = createFileDrop();
    const file = new File(["hello"], "x.md", { type: "text/markdown" });
    await drop.handleEditorDrop(makeDropEvent([file]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dragover sets fileDragOver in browser only", () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const drop = createFileDrop();
    drop.handleEditorDragOver(makeDropEvent([]));
    expect(drop.fileDragOver).toBe(true);

    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const drop2 = createFileDrop();
    drop2.handleEditorDragOver(makeDropEvent([]));
    expect(drop2.fileDragOver).toBe(false);
  });
});
