// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// default-directory.ts pulls its tiers from settings + the integrations endpoint
// + the Tauri path API. Mock all three so the resolver's precedence, short-circuit,
// abort, and error-swallowing behavior can be asserted in isolation (#1023).
vi.mock("../../src/client/hooks/useTandemSettings.js", () => ({
  loadSettings: vi.fn(),
}));
vi.mock("../../src/client/utils/fileUpload.js", () => ({
  API_BASE: "http://127.0.0.1:3479",
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
}));

import { homeDir } from "@tauri-apps/api/path";
import { loadSettings } from "../../src/client/hooks/useTandemSettings.js";
import {
  fetchClaudeWorkingDir,
  readDefaultSaveDirectory,
  resolveDefaultDirectory,
  resolveTauriHomeDir,
} from "../../src/client/utils/default-directory.js";

const mockLoadSettings = vi.mocked(loadSettings);
const mockHomeDir = vi.mocked(homeDir);

/** Minimal stand-in for the persisted settings object — only the one field is read. */
function settingsWith(dir: string | null) {
  mockLoadSettings.mockReturnValue({ defaultSaveDirectory: dir } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveDefaultDirectory precedence (#1023)", () => {
  it("tier 1: returns the configured save folder and never fetches or calls Tauri", async () => {
    settingsWith("/configured/save/dir");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveDefaultDirectory()).resolves.toBe("/configured/save/dir");
    // Short-circuit: the later tiers must not run once tier 1 resolves.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockHomeDir).not.toHaveBeenCalled();
  });

  it("tier 2: falls back to the Claude working dir and does not reach home", async () => {
    settingsWith(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          integrations: [{ kind: "claude-code", workingDirectory: "/claude/working/dir" }],
        }),
      })),
    );

    await expect(resolveDefaultDirectory()).resolves.toBe("/claude/working/dir");
    expect(mockHomeDir).not.toHaveBeenCalled();
  });

  it("tier 3: falls back to the OS home dir when earlier tiers yield nothing", async () => {
    settingsWith(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    mockHomeDir.mockResolvedValue("/home/user");

    await expect(resolveDefaultDirectory()).resolves.toBe("/home/user");
  });

  it("returns null when no tier resolves (caller lets the OS pick)", async () => {
    settingsWith(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    mockHomeDir.mockResolvedValue(null as never);

    await expect(resolveDefaultDirectory()).resolves.toBeNull();
  });
});

describe("fetchClaudeWorkingDir (#1023)", () => {
  it("aborts a hanging integrations fetch after ~250ms and yields null", async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own — only the AbortController's 250ms
    // timeout can settle it. This is the property the CHANGELOG advertises: a
    // dead/slow server can never hang the dialog.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const pending = fetchClaudeWorkingDir();
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(fetchClaudeWorkingDir()).resolves.toBeNull();
  });

  it("returns null when no claude-code integration is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ integrations: [{ kind: "other", workingDirectory: "/x" }] }),
      })),
    );
    await expect(fetchClaudeWorkingDir()).resolves.toBeNull();
  });
});

describe("each tier swallows failures and returns null (#1023)", () => {
  it("readDefaultSaveDirectory returns null when loadSettings throws", () => {
    mockLoadSettings.mockImplementation(() => {
      throw new Error("localStorage blocked");
    });
    expect(readDefaultSaveDirectory()).toBeNull();
  });

  it("fetchClaudeWorkingDir returns null when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchClaudeWorkingDir()).resolves.toBeNull();
  });

  it("resolveTauriHomeDir returns null when the Tauri path API throws", async () => {
    mockHomeDir.mockRejectedValue(new Error("not running under Tauri"));
    await expect(resolveTauriHomeDir()).resolves.toBeNull();
  });
});
