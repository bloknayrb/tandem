import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "../../src/client/utils/confirm";

// happy-dom has no `window.confirm`, so every case installs its own.
function stubConfirm(impl: (message: string) => unknown): void {
  vi.stubGlobal("confirm", impl);
  (window as unknown as { confirm: unknown }).confirm = impl;
}

describe("confirmDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { confirm?: unknown }).confirm;
  });

  it("passes a synchronous browser answer through", async () => {
    stubConfirm(() => true);
    await expect(confirmDialog("q")).resolves.toBe(true);
    stubConfirm(() => false);
    await expect(confirmDialog("q")).resolves.toBe(false);
  });

  // The desktop app's dialog plugin makes `window.confirm` async. The bug this
  // guards: a caller reading the Promise itself as the answer saw OK on Cancel.
  it("awaits an asynchronous (Tauri) answer instead of reading the Promise", async () => {
    stubConfirm(async () => false);
    await expect(confirmDialog("q")).resolves.toBe(false);
    stubConfirm(async () => true);
    await expect(confirmDialog("q")).resolves.toBe(true);
  });

  it("does not resolve until the user answers", async () => {
    let answer!: (ok: boolean) => void;
    stubConfirm(() => new Promise<boolean>((resolve) => (answer = resolve)));
    let settled = false;
    const result = confirmDialog("q").then((ok) => {
      settled = true;
      return ok;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    answer(false);
    await expect(result).resolves.toBe(false);
  });

  it("treats a failed dialog as Cancel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubConfirm(async () => {
      throw new Error("ipc failed");
    });
    await expect(confirmDialog("q")).resolves.toBe(false);
    warn.mockRestore();
  });

  it("passes the message through", async () => {
    const seen: string[] = [];
    stubConfirm((m) => {
      seen.push(m);
      return true;
    });
    await confirmDialog("Close it anyway?");
    expect(seen).toEqual(["Close it anyway?"]);
  });
});
