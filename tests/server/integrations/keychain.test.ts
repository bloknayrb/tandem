import { describe, expect, it } from "vitest";

import {
  createKeychain,
  generateSecretRef,
  KEYCHAIN_SERVICE,
  type KeychainBackend,
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
});
