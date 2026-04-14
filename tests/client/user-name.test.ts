import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistUserName, resolveUserName } from "../../src/client/hooks/useUserName.js";
import { USER_NAME_DEFAULT, USER_NAME_EVENT, USER_NAME_KEY } from "../../src/shared/constants.js";

describe("resolveUserName", () => {
  it("returns stored name when valid", () => {
    expect(resolveUserName("Alice")).toBe("Alice");
  });

  it("returns default for null", () => {
    expect(resolveUserName(null)).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for undefined", () => {
    expect(resolveUserName(undefined)).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for empty string", () => {
    expect(resolveUserName("")).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for whitespace-only", () => {
    expect(resolveUserName("   ")).toBe(USER_NAME_DEFAULT);
  });

  it("trims whitespace from valid name", () => {
    expect(resolveUserName("  Bob  ")).toBe("Bob");
  });
});

describe("persistUserName — write + broadcast contract", () => {
  let store: Map<string, string>;
  let dispatched: string[];

  beforeEach(() => {
    store = new Map();
    dispatched = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } satisfies Storage);
    vi.stubGlobal("window", {
      dispatchEvent: (e: Event) => {
        dispatched.push(e.type);
        return true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trims and writes to localStorage under USER_NAME_KEY", () => {
    persistUserName("  Alice  ");
    expect(store.get(USER_NAME_KEY)).toBe("Alice");
  });

  it("falls back to default for empty input and still writes", () => {
    persistUserName("");
    expect(store.get(USER_NAME_KEY)).toBe(USER_NAME_DEFAULT);
  });

  it("dispatches USER_NAME_EVENT so in-tab subscribers re-read", () => {
    persistUserName("Bob");
    // This assertion is the one that catches the refactor-regression the
    // review flagged: if dispatchEvent is ever dropped from persistUserName,
    // every cross-component subscription silently goes stale until reload.
    expect(dispatched).toContain(USER_NAME_EVENT);
  });

  it("returns the trimmed value that was persisted", () => {
    expect(persistUserName("  Carol  ")).toBe("Carol");
  });

  it("swallows localStorage.setItem errors (incognito/quota) but still dispatches", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } satisfies Storage);
    expect(() => persistUserName("Dave")).not.toThrow();
    expect(dispatched).toContain(USER_NAME_EVENT);
  });
});
