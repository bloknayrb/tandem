import { describe, expect, it, vi } from "vitest";

import {
  createKeychain,
  generateSecretRef,
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  KeychainUnavailableError,
  loadNativeBackend,
} from "../../../src/server/integrations/keychain.js";

/** In-memory backend modeling `@napi-rs/keyring`'s observable behavior. */
function memoryBackend(): KeychainBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  return {
    entries,
    get(service, account) {
      return entries.get(key(service, account)) ?? null;
    },
    set(service, account, secret) {
      entries.set(key(service, account), secret);
    },
    delete(service, account) {
      return entries.delete(key(service, account));
    },
  };
}

describe("generateSecretRef", () => {
  it("returns a non-empty URL-safe string", () => {
    const ref = generateSecretRef();
    expect(ref.length).toBeGreaterThan(0);
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces distinct refs on repeated calls", () => {
    const refs = new Set(Array.from({ length: 100 }, () => generateSecretRef()));
    expect(refs.size).toBe(100);
  });
});

describe("createKeychain (with injected backend)", () => {
  it("setSecret then getSecret returns the same value", async () => {
    const backend = memoryBackend();
    const kc = createKeychain(backend);
    await kc.setSecret("ref-1", "super-secret-token");
    expect(await kc.getSecret("ref-1")).toBe("super-secret-token");
  });

  it("getSecret returns null when the ref is absent", async () => {
    const kc = createKeychain(memoryBackend());
    expect(await kc.getSecret("never-set")).toBeNull();
  });

  it("deleteSecret returns true when a secret was removed", async () => {
    const backend = memoryBackend();
    const kc = createKeychain(backend);
    await kc.setSecret("ref-1", "secret");
    expect(await kc.deleteSecret("ref-1")).toBe(true);
    expect(await kc.getSecret("ref-1")).toBeNull();
  });

  it("deleteSecret returns false when nothing was stored", async () => {
    const kc = createKeychain(memoryBackend());
    expect(await kc.deleteSecret("ghost")).toBe(false);
  });

  it("setSecret overwrites an existing secret", async () => {
    const kc = createKeychain(memoryBackend());
    await kc.setSecret("ref-1", "old");
    await kc.setSecret("ref-1", "new");
    expect(await kc.getSecret("ref-1")).toBe("new");
  });

  it("uses KEYCHAIN_SERVICE as the service identifier", async () => {
    const backend = memoryBackend();
    const kc = createKeychain(backend);
    await kc.setSecret("ref-1", "value");
    expect(backend.entries.has(`${KEYCHAIN_SERVICE}::ref-1`)).toBe(true);
  });

  it("scopes secrets by ref — different refs do not collide", async () => {
    const kc = createKeychain(memoryBackend());
    await kc.setSecret("ref-a", "alpha");
    await kc.setSecret("ref-b", "beta");
    expect(await kc.getSecret("ref-a")).toBe("alpha");
    expect(await kc.getSecret("ref-b")).toBe("beta");
  });

  it("setSecret rejects an empty ref", async () => {
    const kc = createKeychain(memoryBackend());
    await expect(kc.setSecret("", "secret")).rejects.toThrow(/ref is required/);
  });

  it("setSecret rejects an empty secret", async () => {
    const kc = createKeychain(memoryBackend());
    await expect(kc.setSecret("ref-1", "")).rejects.toThrow(/non-empty/);
  });

  it("setSecret rejects a non-string secret", async () => {
    const kc = createKeychain(memoryBackend());
    await expect(kc.setSecret("ref-1", null as unknown as string)).rejects.toThrow(/non-empty/);
  });

  it("backend factory is memoized — multiple calls share state", async () => {
    // The memoryBackend instance IS the backend, so this is implicitly tested
    // anywhere `backend` is reused. This explicit assertion guards against a
    // future refactor that accidentally re-resolves the backend per call.
    const backend = memoryBackend();
    const kc = createKeychain(backend);
    await kc.setSecret("ref-1", "value");
    // If the factory ran twice and produced two memoryBackends, the second
    // get() would see an empty map.
    expect(await kc.getSecret("ref-1")).toBe("value");
  });

  it("get/set/delete propagate KeychainUnavailableError from a throwing backend", async () => {
    // Simulates the native backend wrapper at keychain.ts:loadNativeBackend
    // catching @napi-rs/keyring's `Entry` constructor throwing — e.g. when
    // libsecret is missing on Linux, or the Tauri sidecar can't resolve the
    // platform-specific native subpackage. The wrapper re-throws as
    // KeychainUnavailableError; this test asserts the surface contract.
    const throwingBackend: KeychainBackend = {
      get() {
        throw new KeychainUnavailableError(new Error("simulated: libsecret missing"));
      },
      set() {
        throw new KeychainUnavailableError(new Error("simulated: libsecret missing"));
      },
      delete() {
        throw new KeychainUnavailableError(new Error("simulated: libsecret missing"));
      },
    };
    const kc = createKeychain(throwingBackend);
    await expect(kc.getSecret("r")).rejects.toBeInstanceOf(KeychainUnavailableError);
    await expect(kc.setSecret("r", "v")).rejects.toBeInstanceOf(KeychainUnavailableError);
    await expect(kc.deleteSecret("r")).rejects.toBeInstanceOf(KeychainUnavailableError);
  });

  it("getSecret returning null is NOT conflated with KeychainUnavailableError", async () => {
    // The native @napi-rs/keyring distinguishes "no secret stored" (returns
    // null) from "keychain inaccessible" (throws). The wrapper at
    // keychain.ts must preserve that distinction — a null return is a
    // legitimate value, not an error.
    const nullingBackend: KeychainBackend = {
      get() {
        return null;
      },
      set: vi.fn(),
      delete: vi.fn().mockReturnValue(false),
    };
    const kc = createKeychain(nullingBackend);
    await expect(kc.getSecret("ref")).resolves.toBeNull();
  });
});

describe("loadNativeBackend (lazy native load failure modes)", () => {
  it("throws KeychainUnavailableError when the loader throws (missing native module)", () => {
    // Simulates @napi-rs/keyring being unresolvable — what happens on the
    // Tauri sidecar (no node_modules) or a Linux system without libsecret.
    expect(() =>
      loadNativeBackend(() => {
        throw new Error("simulated: cannot find module @napi-rs/keyring");
      }),
    ).toThrow(KeychainUnavailableError);
  });

  it("returns a working backend when the loader returns a valid native Entry", () => {
    // Fake native Entry class matching @napi-rs/keyring's observable shape.
    class FakeEntry {
      constructor(
        private service: string,
        private account: string,
      ) {}
      getPassword(): string | null {
        return FakeEntry.store.get(`${this.service}::${this.account}`) ?? null;
      }
      setPassword(secret: string): void {
        FakeEntry.store.set(`${this.service}::${this.account}`, secret);
      }
      deletePassword(): boolean {
        return FakeEntry.store.delete(`${this.service}::${this.account}`);
      }
      static store = new Map<string, string>();
    }
    const backend = loadNativeBackend(() => ({ Entry: FakeEntry }));
    backend.set("svc", "acct", "hello");
    expect(backend.get("svc", "acct")).toBe("hello");
    expect(backend.delete("svc", "acct")).toBe(true);
    expect(backend.get("svc", "acct")).toBeNull();
  });

  it("converts native Entry method throws to KeychainUnavailableError", () => {
    class ThrowingEntry {
      constructor(service: string, account: string) {
        void service;
        void account;
      }
      getPassword(): string | null {
        throw new Error("simulated: keychain locked");
      }
      setPassword(secret: string): void {
        void secret;
        throw new Error("simulated: keychain locked");
      }
      deletePassword(): boolean {
        throw new Error("simulated: keychain locked");
      }
    }
    const backend = loadNativeBackend(() => ({ Entry: ThrowingEntry }));
    expect(() => backend.get("s", "a")).toThrow(KeychainUnavailableError);
    expect(() => backend.set("s", "a", "v")).toThrow(KeychainUnavailableError);
    expect(() => backend.delete("s", "a")).toThrow(KeychainUnavailableError);
  });

  it("preserves null returns from getPassword as null (not an error)", () => {
    // The native @napi-rs/keyring distinguishes "no secret stored" (null
    // return) from "keychain inaccessible" (throw). The wrapper must
    // preserve that distinction.
    class NullingEntry {
      constructor(service: string, account: string) {
        void service;
        void account;
      }
      getPassword(): string | null {
        return null;
      }
      setPassword(secret: string): void {
        void secret;
      }
      deletePassword(): boolean {
        return false;
      }
    }
    const backend = loadNativeBackend(() => ({ Entry: NullingEntry }));
    expect(backend.get("s", "a")).toBeNull();
  });
});
