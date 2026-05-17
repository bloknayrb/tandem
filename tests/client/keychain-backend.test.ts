import { describe, expect, it, vi } from "vitest";

import {
  createDefaultKeychainBackend,
  createHttpKeychainBackend,
  createTauriKeychainBackend,
} from "../../src/client/keychain/keychain-backend";
import { ERROR_CODE_KEYCHAIN_UNAVAILABLE } from "../../src/shared/integrations/contract";

describe("createHttpKeychainBackend", () => {
  it("set(): 204 → ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "ok" });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/\/secrets\/ref-1$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("set(): 503 KEYCHAIN_UNAVAILABLE → unavailable", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: ERROR_CODE_KEYCHAIN_UNAVAILABLE }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "unavailable" });
  });

  it("set(): non-KEYCHAIN_UNAVAILABLE 503 → error (not unavailable)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "OTHER" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await backend.set("ref-1", "secret");
    expect(result.status).toBe("error");
  });

  it("set(): 500 → error with HTTP status in message", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "error", message: "HTTP 500" });
  });

  it("set(): network error → error with message", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "error", message: "network down" });
  });

  it("delete(): DELETEs the secret path", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    await backend.delete("ref-1");
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringMatching(/\/secrets\/ref-1$/),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("delete(): swallows network errors (best-effort)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const backend = createHttpKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(backend.delete("ref-1")).resolves.toBeUndefined();
  });
});

describe("createTauriKeychainBackend", () => {
  it("set(): invokes keychain_set with the right args → ok", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriKeychainBackend({ invoke });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "ok" });
    expect(invoke).toHaveBeenCalledWith("keychain_set", { account: "ref-1", secret: "secret" });
  });

  it("set(): keychain-init error → unavailable", async () => {
    const invoke = vi.fn().mockRejectedValue("keychain-init: platform missing");
    const backend = createTauriKeychainBackend({ invoke });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "unavailable" });
  });

  it("set(): keyring PlatformFailure (Display string) → unavailable", async () => {
    // Pinned to keyring v3.6.3's actual Display output in error.rs:64 —
    // NOT the Debug variant name. PR 3c-tauri-keychain's review caught
    // this exact mismatch.
    const invoke = vi
      .fn()
      .mockRejectedValue(
        new Error("keychain-set: Platform secure storage failure: dbus not running"),
      );
    const backend = createTauriKeychainBackend({ invoke });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "unavailable" });
  });

  it("set(): keyring NoStorageAccess (Display string) → unavailable", async () => {
    // keyring v3.6.3 error.rs:65-67 — macOS Keychain locked, Linux dbus
    // unreachable, etc.
    const invoke = vi
      .fn()
      .mockRejectedValue(
        new Error("keychain-set: Couldn't access platform secure storage: locked"),
      );
    const backend = createTauriKeychainBackend({ invoke });
    const result = await backend.set("ref-1", "secret");
    expect(result).toEqual({ status: "unavailable" });
  });

  it("set(): generic error → error with message", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("keychain-set: write denied"));
    const backend = createTauriKeychainBackend({ invoke });
    const result = await backend.set("ref-1", "secret");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/write denied/);
    }
  });

  it("delete(): invokes keychain_delete with the right args", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    const backend = createTauriKeychainBackend({ invoke });
    await backend.delete("ref-1");
    expect(invoke).toHaveBeenCalledWith("keychain_delete", { account: "ref-1" });
  });

  it("delete(): swallows errors (best-effort)", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("anything"));
    const backend = createTauriKeychainBackend({ invoke });
    await expect(backend.delete("ref-1")).resolves.toBeUndefined();
  });
});

describe("createDefaultKeychainBackend", () => {
  it("force: 'http' picks the HTTP backend regardless of runtime", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const backend = createDefaultKeychainBackend({
      force: "http",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await backend.set("ref", "v");
    expect(fetchFn).toHaveBeenCalled();
  });

  it("force: 'tauri' picks the Tauri backend regardless of runtime", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const backend = createDefaultKeychainBackend({ force: "tauri", invoke });
    await backend.set("ref", "v");
    expect(invoke).toHaveBeenCalledWith("keychain_set", { account: "ref", secret: "v" });
  });

  it("no force, no Tauri global → HTTP backend (vitest runs without window.__TAURI_INTERNALS__)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    // happy-dom env in vitest has window but no __TAURI_INTERNALS__, so the
    // default is HTTP. This pins that behavior so a future test-env change
    // doesn't silently flip the default.
    const backend = createDefaultKeychainBackend({ fetchFn: fetchFn as unknown as typeof fetch });
    await backend.set("ref", "v");
    expect(fetchFn).toHaveBeenCalled();
  });
});
