import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import { createFileDrop } from "../../src/client/hooks/useFileDrop.svelte.js";
import { DOCX_UNSUPPORTED_MESSAGE } from "../../src/shared/constants.js";

vi.mock(import("../../src/client/cowork/cowork-helpers.js"), () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock(import("../../src/client/utils/fileUpload.js"), () => ({
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
    const drop = createFileDrop(vi.fn());
    const file = new File(["hello"], "x.md", { type: "text/markdown" });
    await drop.handleEditorDrop(makeDropEvent([file]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/upload");
    expect(init.method).toBe("POST");
  });

  it("shows the server's refusal in a toast, e.g. the Word message for a .docx (ADR-053)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "BAD_REQUEST", message: DOCX_UNSUPPORTED_MESSAGE }),
    });
    const push = vi.fn();
    const drop = createFileDrop(push);
    await drop.handleEditorDrop(makeDropEvent([new File(["zip"], "report.docx")]));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ severity: "warning" });
    expect(push.mock.calls[0][0].message).toContain(DOCX_UNSUPPORTED_MESSAGE);
  });

  it("stays quiet on a successful upload", async () => {
    const push = vi.fn();
    const drop = createFileDrop(push);
    await drop.handleEditorDrop(makeDropEvent([new File(["hello"], "x.md")]));
    expect(push).not.toHaveBeenCalled();
  });

  it("early-returns in Tauri runtime — no upload, native handler owns the drop", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const drop = createFileDrop(vi.fn());
    const file = new File(["hello"], "x.md", { type: "text/markdown" });
    await drop.handleEditorDrop(makeDropEvent([file]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dragover sets fileDragOver in browser only", () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const drop = createFileDrop(vi.fn());
    drop.handleEditorDragOver(makeDropEvent([]));
    expect(drop.fileDragOver).toBe(true);

    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const drop2 = createFileDrop(vi.fn());
    drop2.handleEditorDragOver(makeDropEvent([]));
    expect(drop2.fileDragOver).toBe(false);
  });
});
