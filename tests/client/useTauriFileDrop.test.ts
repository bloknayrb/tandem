import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import * as serverPaths from "../../src/client/utils/server-paths.js";
import { SUPPORTED_EXTENSIONS } from "../../src/shared/constants.js";

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
const onDragDropEventSpy = vi.fn(async (cb: (event: { payload: DropEvent }) => void) => {
  registered = cb;
  return () => {
    registered = null;
  };
});
const getCurrentWebviewSpy = vi.fn(() => ({
  onDragDropEvent: onDragDropEventSpy,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: getCurrentWebviewSpy,
}));

async function loadFreshHook() {
  vi.resetModules();
  return await import("../../src/client/hooks/useTauriFileDrop.svelte.js");
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("useTauriFileDrop", () => {
  beforeEach(() => {
    registered = null;
    onDragDropEventSpy.mockClear();
    getCurrentWebviewSpy.mockClear();
    getCurrentWebviewSpy.mockImplementation(() => ({ onDragDropEvent: onDragDropEventSpy }));
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
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    expect(registered).toBeNull();
  });

  it("opens a dropped file via openServerPath on Tauri", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    expect(registered).not.toBeNull();
    registered!({ payload: { type: "drop", paths: ["C:/notes/x.md"] } });
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/notes/x.md");
  });

  it("ignores unsupported extensions", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    registered!({ payload: { type: "drop", paths: ["C:/bin/app.exe"] } });
    expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
  });

  it("opens only the first supported path when multiple are dropped", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    registered!({
      payload: {
        type: "drop",
        paths: ["C:/skipped.exe", "C:/first.md", "C:/second.txt"],
      },
    });
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith("C:/first.md");
  });

  // Regression coverage for the basename-extraction + dot<=0 fix in
  // commit 8e73059. Each row pins one equivalence class of the
  // extensionAllowed() invariant. Adding a new extension to
  // SUPPORTED_EXTENSIONS should not need to change any of these rows.
  it.each([
    // Negative: drop should reject AND fire the "unsupported" toast.
    {
      path: "/my.files/readme",
      expected: "reject",
      why: "dot in parent dir, no extension on file",
    },
    { path: "/home/user/.md", expected: "reject", why: "bare dotfile, basename starts with dot" },
    { path: "/file.", expected: "reject", why: "trailing dot, empty extension" },
    // Positive: drop should call openServerPath with the path.
    {
      path: "/my.files/notes.md",
      expected: "open",
      why: "forward-slash, dot in parent dir, valid ext",
    },
    {
      path: "C:\\Users\\foo\\notes.md",
      expected: "open",
      why: "pure backslash, no dot-in-parent confound",
    },
    {
      path: "C:\\my.docs\\notes.md",
      expected: "open",
      why: "backslash + dot in parent dir + valid ext",
    },
    {
      path: "C:/dir\\sub.files/x.md",
      expected: "open",
      why: "mixed forward/back separator with dot-in-parent",
    },
    {
      path: "/home/user/.notes.md",
      expected: "open",
      why: "dotfile with real extension (dot <= 0 didn't overshoot)",
    },
  ])("path-edge: $why — $path → $expected", async ({ path, expected }) => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const push = vi.fn();
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(push);
    await flushMicrotasks();
    registered!({ payload: { type: "drop", paths: [path] } });

    if (expected === "open") {
      expect(vi.mocked(serverPaths.openServerPath)).toHaveBeenCalledWith(path);
    } else {
      expect(vi.mocked(serverPaths.openServerPath)).not.toHaveBeenCalled();
      // Dual assertion: prove the rejection reached the "unsupported"
      // branch rather than silently falling through a future bug.
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0][0]).toMatchObject({ dedupKey: "tauri-drop-unsupported" });
    }
  });

  it("flips fileDragOver true on enter and false on leave", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, tauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    expect(tauriFileDrop.fileDragOver).toBe(false);
    registered!({ payload: { type: "enter", paths: ["C:/x.md"] } });
    expect(tauriFileDrop.fileDragOver).toBe(true);
    registered!({ payload: { type: "leave" } });
    expect(tauriFileDrop.fileDragOver).toBe(false);
  });

  it("idempotency: second initTauriFileDrop call does not register a second listener", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    onDragDropEventSpy.mockClear();
    getCurrentWebviewSpy.mockClear();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    initTauriFileDrop(vi.fn());
    await flushMicrotasks();
    expect(getCurrentWebviewSpy).toHaveBeenCalledTimes(1);
    expect(onDragDropEventSpy).toHaveBeenCalledTimes(1);
  });

  it("drop clears the overlay even when followed only by unsupported paths (overlay-leak guard)", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const push = vi.fn();
    const { initTauriFileDrop, tauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(push);
    await flushMicrotasks();
    registered!({ payload: { type: "enter", paths: ["C:/x.exe"] } });
    expect(tauriFileDrop.fileDragOver).toBe(true);
    registered!({ payload: { type: "drop", paths: ["C:/x.exe", "C:/y.pdf"] } });
    expect(tauriFileDrop.fileDragOver).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({
      severity: "warning",
      dedupKey: "tauri-drop-unsupported",
    });
    expect(push.mock.calls[0][0].message).toContain(".md");
  });

  it("unsupported-drop toast lists every supported extension as a delimited token", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const push = vi.fn();
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(push);
    await flushMicrotasks();
    registered!({ payload: { type: "drop", paths: ["/x.exe"] } });

    // Pin the toast we're reading before asserting on its content, so
    // a future refactor that fires a different toast first can't shift
    // the target silently.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].dedupKey).toBe("tauri-drop-unsupported");

    const msg = push.mock.calls[0][0].message as string;
    for (const ext of SUPPORTED_EXTENSIONS) {
      // Delimited-token match: ext must NOT be followed by another letter.
      // Rejects substring-only matches like `.htm` inside `.html` (the very
      // hazard that hid the original bug 8e73059 fixed) or `.md` inside a
      // future `.markdown`.
      const escaped = ext.replace(/\./g, "\\.");
      expect(msg).toMatch(new RegExp(`${escaped}(?![a-zA-Z])`));
    }
  });

  it("surfaces openServerPath failure as an error toast", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    vi.mocked(serverPaths.openServerPath).mockResolvedValue({
      ok: false,
      error: "file not found",
    });
    const push = vi.fn();
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(push);
    await flushMicrotasks();
    registered!({ payload: { type: "drop", paths: ["C:/missing.md"] } });
    // The IIFE awaits openServerPath; drain microtasks twice (promise + push).
    await flushMicrotasks();
    await flushMicrotasks();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({
      severity: "error",
      dedupKey: "tauri-drop-open-failed",
    });
    expect(push.mock.calls[0][0].message).toContain("file not found");
  });

  it("dynamic-import failure pushes 'unavailable' toast and resets for retry", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    // Make the very first getCurrentWebview() call throw, simulating a
    // module-load / API failure during the dynamic-import .then chain.
    getCurrentWebviewSpy.mockImplementationOnce(() => {
      throw new Error("module load failed");
    });
    const push = vi.fn();
    const { initTauriFileDrop, _resetForTests } = await loadFreshHook();
    _resetForTests();
    initTauriFileDrop(push);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({
      severity: "warning",
      dedupKey: "tauri-drop-unavailable",
    });
    expect(push.mock.calls[0][0].message).toContain("unavailable");

    // Second call should retry (the .catch reset _initialized).
    initTauriFileDrop(push);
    await flushMicrotasks();
    expect(getCurrentWebviewSpy).toHaveBeenCalledTimes(2);
    expect(onDragDropEventSpy).toHaveBeenCalledTimes(1);
  });
});
