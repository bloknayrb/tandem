/**
 * Unit tests for the client save-as helpers in `actions/builtin.svelte.ts`.
 *
 * Covers the pure extension-normalization logic and the anchor-download
 * shim — both used by the Save As command (Ctrl+Shift+S / palette).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBlob, normalizeSaveAsExtension } from "../../src/client/actions/builtin.svelte.js";

describe("normalizeSaveAsExtension", () => {
  it("keeps a matching extension untouched", () => {
    expect(normalizeSaveAsExtension("/tmp/notes.md", "md")).toBe("/tmp/notes.md");
    expect(normalizeSaveAsExtension("/tmp/notes.txt", "txt")).toBe("/tmp/notes.txt");
  });

  it("matches case-insensitively (Windows file pickers may uppercase)", () => {
    expect(normalizeSaveAsExtension("/tmp/notes.MD", "md")).toBe("/tmp/notes.MD");
  });

  it("appends the chosen extension when none is present", () => {
    expect(normalizeSaveAsExtension("/tmp/notes", "md")).toBe("/tmp/notes.md");
    expect(normalizeSaveAsExtension("/tmp/notes", "txt")).toBe("/tmp/notes.txt");
  });

  it("overrides a non-matching extension", () => {
    expect(normalizeSaveAsExtension("/tmp/notes.rtf", "md")).toBe("/tmp/notes.md");
    expect(normalizeSaveAsExtension("/tmp/notes.html", "txt")).toBe("/tmp/notes.txt");
  });

  it("handles Windows-style backslash paths", () => {
    expect(normalizeSaveAsExtension("C:\\Users\\me\\notes", "md")).toBe("C:\\Users\\me\\notes.md");
    expect(normalizeSaveAsExtension("C:\\Users\\me\\notes.rtf", "md")).toBe(
      "C:\\Users\\me\\notes.md",
    );
  });

  it("dots inside directory names are not treated as the file extension", () => {
    // The basename is `notes` (no dot), so the function should append .md.
    expect(normalizeSaveAsExtension("/tmp/my.folder/notes", "md")).toBe("/tmp/my.folder/notes.md");
  });
});

describe("downloadBlob", () => {
  // Stub URL.createObjectURL/revokeObjectURL — jsdom doesn't implement them.
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an anchor, clicks it, and revokes the object URL after a tick", () => {
    vi.useFakeTimers();
    // Intercept anchor click to verify the file name + URL plumbing.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // Snapshot href/download at click time so we can assert below.
      (this as unknown as { _capturedHref: string })._capturedHref = this.href;
      (this as unknown as { _capturedDownload: string })._capturedDownload = this.download;
    });

    downloadBlob("hello world", "Scratchpad.md", "text/markdown");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.contexts[0] as unknown as {
      _capturedHref: string;
      _capturedDownload: string;
    };
    expect(anchor._capturedHref).toBe("blob:mock");
    expect(anchor._capturedDownload).toBe("Scratchpad.md");

    // The object URL is revoked on the next macrotask.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    clickSpy.mockRestore();
  });
});
