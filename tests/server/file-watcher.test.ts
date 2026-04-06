import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  watchFile,
  unwatchFile,
  unwatchAll,
  suppressNextChange,
  watchedCount,
} from "../../src/server/file-watcher.js";

// We mock fs.watch to avoid touching the real filesystem
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      watch: vi.fn(),
    },
    watch: vi.fn(),
  };
});

const mockWatch = fs.watch as ReturnType<typeof vi.fn>;

interface MockWatcher {
  changeHandler: ((eventType: string) => void) | null;
  errorHandler: ((err: Error) => void) | null;
  closed: boolean;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockWatcher(): MockWatcher {
  const watcher: MockWatcher = {
    changeHandler: null,
    errorHandler: null,
    closed: false,
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === "error") watcher.errorHandler = handler;
      return watcher;
    }),
    close: vi.fn(() => {
      watcher.closed = true;
    }),
  };
  return watcher;
}

beforeEach(() => {
  vi.useFakeTimers();
  unwatchAll();
  mockWatch.mockReset();
});

afterEach(() => {
  unwatchAll();
  vi.useRealTimers();
});

describe("watchFile", () => {
  it("registers a watcher for a new file path", () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    watchFile("/tmp/test.md", vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(1);
    expect(mockWatch).toHaveBeenCalledWith("/tmp/test.md", expect.any(Function));
  });

  it("is a no-op for already-watched paths", () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    watchFile("/tmp/test.md", vi.fn().mockResolvedValue(undefined));
    watchFile("/tmp/test.md", vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(1);
    expect(mockWatch).toHaveBeenCalledTimes(1);
  });

  it("calls onChanged after 500ms debounce on change event", async () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    // Simulate a change event
    watcher.changeHandler!("change");
    expect(onChanged).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledWith("/tmp/test.md");
  });

  it("debounces rapid change events", async () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    // Rapid changes
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(200);
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(200);
    watcher.changeHandler!("change");

    // Only the last debounced call should fire
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("ignores non-change events (e.g. rename)", async () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    watcher.changeHandler!("rename");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("handles fs.watch throwing on setup", () => {
    mockWatch.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    // Should not throw — logs and returns
    watchFile("/tmp/missing.md", vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(0);
  });
});

describe("suppressNextChange", () => {
  it("skips the next change callback when suppressed", async () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    suppressNextChange("/tmp/test.md");

    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).not.toHaveBeenCalled();

    // Next change should fire normally
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for unwatched paths", () => {
    // Should not throw
    suppressNextChange("/tmp/nonexistent.md");
  });
});

describe("unwatchFile", () => {
  it("stops watching and closes the watcher", () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    watchFile("/tmp/test.md", vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(1);

    unwatchFile("/tmp/test.md");
    expect(watchedCount()).toBe(0);
    expect(watcher.close).toHaveBeenCalled();
  });

  it("is a no-op for unwatched paths", () => {
    unwatchFile("/tmp/nonexistent.md");
    expect(watchedCount()).toBe(0);
  });
});

describe("unwatchAll", () => {
  it("closes all watchers", () => {
    const watchers: MockWatcher[] = [];
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      const w = createMockWatcher();
      w.changeHandler = cb;
      watchers.push(w);
      return w;
    });

    watchFile("/tmp/a.md", vi.fn().mockResolvedValue(undefined));
    watchFile("/tmp/b.md", vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(2);

    unwatchAll();
    expect(watchedCount()).toBe(0);
    for (const w of watchers) {
      expect(w.close).toHaveBeenCalled();
    }
  });
});
