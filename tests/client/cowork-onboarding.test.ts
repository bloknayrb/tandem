import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
  writeCoworkOnboardingSkipped,
} from "../../src/client/cowork/cowork-helpers.js";
import type { CoworkStatus } from "../../src/client/types.js";
import { COWORK_ONBOARDING_SKIPPED_KEY } from "../../src/shared/constants.js";

function makeStatus(overrides: Partial<CoworkStatus> = {}): CoworkStatus {
  return {
    osSupported: true,
    coworkDetected: true,
    enabled: false,
    vethernetCidr: "172.20.0.0/20",
    lanIpFallback: null,
    useLanIpOverride: false,
    workspaces: [],
    uacDeclined: false,
    uacDeclinedAt: null,
    ...overrides,
  };
}

describe("shouldShowCoworkOnboarding", () => {
  it("returns false when status is still loading", () => {
    expect(shouldShowCoworkOnboarding(null, false)).toBe(false);
  });

  it("returns false when the user already skipped", () => {
    expect(shouldShowCoworkOnboarding(makeStatus(), true)).toBe(false);
  });

  it("returns false on non-Windows (osSupported=false)", () => {
    expect(shouldShowCoworkOnboarding(makeStatus({ osSupported: false }), false)).toBe(false);
  });

  it("returns false when Cowork is not detected", () => {
    expect(shouldShowCoworkOnboarding(makeStatus({ coworkDetected: false }), false)).toBe(false);
  });

  it("returns false when Cowork is already enabled (nothing to prompt)", () => {
    expect(shouldShowCoworkOnboarding(makeStatus({ enabled: true }), false)).toBe(false);
  });

  it("returns true when Windows + Cowork detected + not enabled + not skipped", () => {
    expect(shouldShowCoworkOnboarding(makeStatus(), false)).toBe(true);
  });
});

describe("cowork onboarding skip flag persistence", () => {
  // Reuse the same localStorage stub pattern as useTandemSettings.test.ts.
  function installLocalStorageStub() {
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

  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("readCoworkOnboardingSkipped returns false when nothing is stored", () => {
    expect(readCoworkOnboardingSkipped()).toBe(false);
  });

  it("readCoworkOnboardingSkipped returns true after writeCoworkOnboardingSkipped", () => {
    writeCoworkOnboardingSkipped();
    expect(store.get(COWORK_ONBOARDING_SKIPPED_KEY)).toBe("true");
    expect(readCoworkOnboardingSkipped()).toBe(true);
  });

  it("readCoworkOnboardingSkipped returns false for non-'true' values (forward compat)", () => {
    store.set(COWORK_ONBOARDING_SKIPPED_KEY, "1");
    expect(readCoworkOnboardingSkipped()).toBe(false);
    store.set(COWORK_ONBOARDING_SKIPPED_KEY, "yes");
    expect(readCoworkOnboardingSkipped()).toBe(false);
  });

  it("readCoworkOnboardingSkipped survives incognito (getItem throws)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } satisfies Storage);
    expect(readCoworkOnboardingSkipped()).toBe(false);
  });

  it("writeCoworkOnboardingSkipped is a silent no-op when setItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } satisfies Storage);
    expect(() => writeCoworkOnboardingSkipped()).not.toThrow();
  });
});
