import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("../../src/client/utils/server-paths.js", () => ({
  openServerPath: vi.fn(),
}));

// Captures the most recently registered onDragDropEvent callback so each
// test can fire synthetic payloads at it.
type DropEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };
let registered: ((event: { payload: DropEvent }) => void) | null = null;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(async (cb: (event: { payload: DropEvent }) => void) => {
      registered = cb;
      return () => {
        registered = null;
      };
    }),
  })),
}));

async function loadFreshHook() {
  vi.resetModules();
  return await import("../../src/client/hooks/useTauriFileDrop.svelte.js");
}

describe("useTauriFileDrop", () => {
  beforeEach(() => {
    registered = null;
    vi.mocked(serverPaths.openServerPath).mockReset();
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({ ok: true });
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  afterEach(() => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  it("is a no-op in browser runtime (no listener attached)", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop();
    await new Promise((r) => setTimeout(r, 0));
    expect(registered).toBeNull();
  });

  it("opens a dropped file via openServerPath on Tauri", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop();
    await new Promise((r) => setTimeout(r, 0));
    expect(registered).not.toBeNull();
    registered!({ payload: { type: "drop", paths: ["C:/notes/x.md"] } });
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/notes/x.md");
  });

  it("ignores unsupported extensions", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop();
    await new Promise((r) => setTimeout(r, 0));
    registered!({ payload: { type: "drop", paths: ["C:/bin/app.exe"] } });
    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
  });

  it("opens only the first supported path when multiple are dropped", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop();
    await new Promise((r) => setTimeout(r, 0));
    registered!({
      payload: {
        type: "drop",
        paths: ["C:/skipped.exe", "C:/first.md", "C:/second.txt"],
      },
    });
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/first.md");
  });

  it("flips fileDragOver true on enter and false on leave", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, tauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop();
    await new Promise((r) => setTimeout(r, 0));
    expect(tauriFileDrop.fileDragOver).toBe(false);
    registered!({ payload: { type: "enter", paths: ["C:/x.md"] } });
    expect(tauriFileDrop.fileDragOver).toBe(true);
    registered!({ payload: { type: "leave" } });
    expect(tauriFileDrop.fileDragOver).toBe(false);
  });
});
