import { vi } from "vitest";

/**
 * Install an in-memory `Storage` stub as `globalThis.localStorage` (via
 * `vi.stubGlobal`) and return the backing `Map` so tests can seed/inspect
 * raw entries directly. Callers are responsible for `vi.unstubAllGlobals()`
 * in an `afterEach` to tear it down between tests.
 */
export function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  vi.stubGlobal("localStorage", stub);
  return store;
}
