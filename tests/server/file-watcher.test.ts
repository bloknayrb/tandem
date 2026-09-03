import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rearmWatch,
  recordSelfWrite,
  suppressNextChange,
  unwatchAll,
  unwatchFile,
  watchedCount,
  watchFile,
} from "../../src/server/file-watcher.js";
import { getBuffer, resetForTesting } from "../../src/server/notifications.js";

/**
 * Per-CALL deferred queue for the delivery `stat`, not a per-test flag (#1749).
 *
 * The ordering cases need two DIFFERENT verdicts for ONE path inside ONE test,
 * settled in a controlled order. A per-test flag settles delivery 1 inside the
 * same `advanceTimersByTimeAsync(500)`, so the two deliveries never overlap and
 * the whole class of stale-verdict bugs becomes unbuildable. `vi.hoisted`
 * because the mock factory below is hoisted above this declaration.
 */
const statQueue = vi.hoisted(() => [] as Promise<unknown>[]);

// We mock fs.watch to avoid touching the real filesystem, and fs.promises.stat
// because every path in this suite is fake (`/tmp/test.md` etc.) — the delivery
// `stat` would otherwise resolve ENOENT and send every existing case down the
// missing branch. The override lands in BOTH `default` and the namespace (the
// module under test does `import fs from "node:fs"`, so it reads
// `default.promises.stat`) and SPREADS `actual.promises`, or `isSelfWriteEcho`'s
// real `readFile` disappears.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const promises = {
    ...actual.promises,
    stat: vi.fn(() => statQueue.shift() ?? Promise.resolve({ isFile: () => true })),
  };
  return {
    ...actual,
    promises,
    default: {
      ...actual,
      promises,
      watch: vi.fn(),
    },
    watch: vi.fn(),
  };
});

const mockWatch = fs.watch as ReturnType<typeof vi.fn>;

const ORIGINAL_PLATFORM = process.platform;

/**
 * The repo's platform-stub idiom (`document-service.test.ts:963-970`,
 * `file-io/doc-backup.test.ts`, `integrations/apply-acl.test.ts`).
 * `vi.stubGlobal("process", …)` does NOT work — imported modules keep the same
 * `process` object. Every stubbed case restores in a `finally`: a leaked
 * `platform: "linux"` would make every LATER win32-gated assertion test the
 * stub instead of the host, including the paired-direction "no second fs.watch
 * on win32" proof that is the only thing keeping the linux half non-vacuous.
 */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
}

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

/**
 * A fresh `createMockWatcher()` per `fs.watch` call, so handle identity is
 * observable. The suite's older shared-object idiom cannot express any of the
 * re-arm cases: with one object reused, `oldHandle === newHandle`, so the
 * identity check never short-circuits and a re-arm would close the handle it
 * just attached. `order`, when passed, records the interleaving of `fs.watch`
 * and `close()` — vitest ships no `toHaveBeenCalledBefore`.
 */
function freshWatcherPerCall(order?: string[]): MockWatcher[] {
  const handles: MockWatcher[] = [];
  mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
    const w = createMockWatcher();
    w.changeHandler = cb;
    w.close.mockImplementation(() => {
      w.closed = true;
      order?.push("close");
    });
    handles.push(w);
    order?.push("watch");
    return w;
  });
  return handles;
}

beforeEach(() => {
  vi.useFakeTimers();
  unwatchAll();
  mockWatch.mockReset();
  // Module-scoped and never reset by `mockReset` — a case that pushes two
  // deferreds and aborts on a failed `expect` before both are shifted would
  // otherwise leak a verdict into the next test.
  statQueue.length = 0;
  resetForTesting();
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

  it("schedules the debounce on a rename event (#1749)", async () => {
    // This case asserted the OPPOSITE until #1749 ("ignores non-change events").
    // Dropping `rename` is what made an external atomic save — vim, VS Code,
    // `sed -i`, git, anything tmp+rename — invisible on EVERY platform: on
    // Linux a rename-replace emits only `rename`, and on Windows an external
    // tmp+rename emits `rename, rename` and no `change` at all.
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    watcher.changeHandler!("rename");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).toHaveBeenCalledWith("/tmp/test.md");
  });

  it("consumes the suppression counter for a rename too, at arrival", async () => {
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    suppressNextChange("/tmp/test.md");
    watcher.changeHandler!("rename");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).not.toHaveBeenCalled();

    watcher.changeHandler!("rename");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).toHaveBeenCalledTimes(1);
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

  it("swallows multiple events when suppress is called multiple times", async () => {
    // An atomic save on Windows produces two or three events — measured on
    // Node 24, `rename, rename` via a synchronous temp write and
    // `rename, rename, change` via `fs.promises`, never a lone `change` (the
    // claim this comment carried before #1749). A second suppressNextChange()
    // before any event arrives should bump the counter so BOTH synthetic events
    // are swallowed and the next real one fires normally.
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    suppressNextChange("/tmp/test.md");
    suppressNextChange("/tmp/test.md");

    watcher.changeHandler!("change");
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).not.toHaveBeenCalled();

    // Third event is an external edit — must fire.
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("expires suppression after the TTL so unmatched suppress calls can't swallow real events", async () => {
    // A suppressNextChange() with no matching event arrival would otherwise
    // leave a stale boolean flag that swallows the next external change. The
    // counter-with-TTL design clears the state after 2s.
    const watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });

    const onChanged = vi.fn().mockResolvedValue(undefined);
    watchFile("/tmp/test.md", onChanged);

    suppressNextChange("/tmp/test.md");
    // Advance past the TTL (2000ms) without any change event firing.
    await vi.advanceTimersByTimeAsync(2500);

    // This event is a genuine external change — must fire, not be swallowed
    // by the expired suppression.
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(600);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("recordSelfWrite / self-write echo guard", () => {
  // Stays on the suite-wide fake timers: the delivery guard's
  // `fs.promises.readFile` is mocked so the whole path resolves on the
  // microtask queue (no real I/O, no wall-clock waits → no flake under load).
  const file = "/tmp/echo.md";
  let onChanged: ReturnType<typeof vi.fn<(filePath: string) => Promise<void>>>;
  let watcher: MockWatcher;
  let readFile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    watcher = createMockWatcher();
    mockWatch.mockImplementation((_path: string, cb: (eventType: string) => void) => {
      watcher.changeHandler = cb;
      return watcher;
    });
    onChanged = vi.fn<(filePath: string) => Promise<void>>().mockResolvedValue(undefined);
    readFile = vi.spyOn(fs.promises, "readFile");
  });

  afterEach(() => {
    readFile.mockRestore();
  });

  it("suppresses the echo of a self-write when disk bytes are identical", async () => {
    const content = "hello world";
    readFile.mockResolvedValue(Buffer.from(content));
    watchFile(file, onChanged);
    recordSelfWrite(file, content);

    // Two leaked events (NTFS-style); no suppressNextChange here, so the content
    // fingerprint is the only thing that can stop them reaching onChanged.
    watcher.changeHandler!("change");
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reloads when the file actually changed (different length)", async () => {
    readFile.mockResolvedValue(Buffer.from("hello world — and then some more"));
    watchFile(file, onChanged);
    recordSelfWrite(file, "hello world");

    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reloads an equal-length external edit (content hash, not size+mtime)", async () => {
    // The case a size/mtime proxy would silently drop: a single-character swap
    // that keeps the byte length identical. Must reload, not skip.
    readFile.mockResolvedValue(Buffer.from("BBBB")); // same length as recorded, different bytes
    watchFile(file, onChanged);
    recordSelfWrite(file, "AAAA");

    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reloads identical bytes once the echo window (TTL) has expired", async () => {
    // The fingerprint is a short-lived echo detector, not a content oracle: a
    // later external revert-to-identical-bytes must still reload.
    const content = "hello world";
    readFile.mockResolvedValue(Buffer.from(content));
    watchFile(file, onChanged);
    recordSelfWrite(file, content);

    await vi.advanceTimersByTimeAsync(2100); // past SUPPRESS_TTL_MS (2000)
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("is inert when no fingerprint was recorded (does not skip, does not read)", async () => {
    watchFile(file, onChanged);
    // no recordSelfWrite — the guard must fall straight through to a reload
    // without ever touching the disk.
    watcher.changeHandler!("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// #1749 — `rename` handling, the POSIX re-arm, and the handles it mints.
//
// Every case below that is platform-gated STUBS `process.platform` and restores
// it in a `finally`, and asserts `process.platform` at the top so "the stub
// took" is provable rather than assumed. An ESM spy on the module-private
// `isWin32` is never consulted by its own callers, so the second half of the
// proof is running the SAME scenario under both stubs and asserting DIFFERENT
// observable behaviour (a second `fs.watch` on linux, none on win32).
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PRESENT = () => Promise.resolve({ isFile: () => true });

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

/**
 * A rejected promise that is already "handled" for Node bookkeeping purposes.
 *
 * A bare `Promise.reject(...)` pushed onto `statQueue` fires
 * `unhandledRejection` on the first microtask checkpoint — before the timer
 * body shifts and awaits it — which is a TEST artifact that would otherwise
 * trip the very spy these cases use to prove the product never rejects.
 */
function rejected(err: unknown): Promise<never> {
  const p = Promise.reject(err);
  p.catch(() => {});
  return p;
}

function emfile(): NodeJS.ErrnoException {
  return Object.assign(new Error("EMFILE"), { code: "EMFILE" });
}

function lostWatchNotifications(file: string) {
  return getBuffer().filter((n) => n.dedupKey === `watch-lost:${file}`);
}

describe("the INITIAL arm reports its own failure", () => {
  const file = "/tmp/initial-arm.md";

  it("watchFile returns false and NOTIFIES when fs.watch refuses the path", () => {
    // A failed re-arm has always routed to `notifyWatchLost`; the initial arm
    // was a bare `console.error` with `wireFileWatcher`'s catch as a second
    // silent layer — identical consequence, no user-facing signal. Save-as
    // newly depends on this arm and its target is deliberately unconfined
    // (network shares, external drives), which is exactly where `fs.watch` is
    // unsupported or returns EPERM/ENOSPC/EMFILE. Nothing re-arms after an
    // open, so the document stays unwatched for its whole lifetime.
    mockWatch.mockImplementationOnce(() => {
      throw emfile();
    });

    expect(watchFile(file, vi.fn().mockResolvedValue(undefined))).toBe(false);
    expect(watchedCount()).toBe(0);
    expect(lostWatchNotifications(file)).toHaveLength(1);
  });

  it("paired direction: a successful arm returns true and notifies nothing", () => {
    // Without this, a `notifyNotWatching` moved out of the catch and fired
    // unconditionally passes the case above.
    freshWatcherPerCall();

    expect(watchFile(file, vi.fn().mockResolvedValue(undefined))).toBe(true);
    expect(watchedCount()).toBe(1);
    expect(lostWatchNotifications(file)).toHaveLength(0);
  });

  it("an already-watched path returns true without a second fs.watch", () => {
    freshWatcherPerCall();
    expect(watchFile(file, vi.fn().mockResolvedValue(undefined))).toBe(true);
    expect(watchFile(file, vi.fn().mockResolvedValue(undefined))).toBe(true);
    expect(mockWatch).toHaveBeenCalledTimes(1);
  });
});

describe("rename re-arm (POSIX) / no-op (win32)", () => {
  const file = "/tmp/rearm.md";

  it("row A: rearmWatch attaches the NEW handle before closing the old", () => {
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const order: string[] = [];
      const handles = freshWatcherPerCall(order);
      watchFile(file, vi.fn().mockResolvedValue(undefined));
      order.length = 0; // drop the initial arm

      rearmWatch(file);

      // Asserted on the mock's RECORDED order, not on which handle later
      // emits. A write landing between a `close()` and a later `fs.watch` is
      // seen by nobody; an overlap can only double-deliver, and the debounce
      // coalesces that.
      expect(order).toEqual(["watch", "close"]);
      expect(handles).toHaveLength(2);
      expect(handles[0].closed).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("row B: a rename delivery re-arms once with the SAME callback; a following change does not", async () => {
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      handles[1].changeHandler!("change");
      await vi.advanceTimersByTimeAsync(500);

      // CUMULATIVE: one from watchFile, one from the rename re-arm, none from
      // the `change` — which is what pins the `sawRename = false` clear. A
      // forgotten clear makes this 3, and nothing else in the suite sees it.
      expect(mockWatch).toHaveBeenCalledTimes(2);
      // The re-arm must hand the SAME hoisted callback to the new handle. A
      // re-arm spelled `fs.watch(filePath, () => {})` passes every other
      // assertion here (this suite drives deliveries through the captured
      // callback) and loses every event on a real inode replacement.
      expect(mockWatch.mock.calls[1][1]).toBe(mockWatch.mock.calls[0][1]);
      // The second handle gets its OWN error listener. Asserted on that
      // handle's own spy: a shared `on` spy is already satisfied by the initial
      // arm, so it would pass an inlined `fs.watch` that skips `attachWatcher`.
      expect(handles[1].on).toHaveBeenCalledWith("error", expect.any(Function));
    } finally {
      restorePlatform();
    }
  });

  it("win32: the same scenario mints no second fs.watch (the handle survives by construction)", async () => {
    stubPlatform("win32");
    try {
      expect(process.platform).toBe("win32");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWatch).toHaveBeenCalledTimes(1);
      // …and rearmWatch itself is a no-op here, not merely unreached.
      rearmWatch(file);
      expect(mockWatch).toHaveBeenCalledTimes(1);
      expect(handles[0].closed).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it("POSIX re-arm CLEARS the pending suppression", async () => {
    // Without the clear, a self-write whose own `rename` never reached the old
    // handle (on Linux the ordinary case — the event is dropped with the inode)
    // leaves the counter armed for the full 2 s TTL, and the next EXTERNAL
    // atomic save is swallowed at arrival. That is #1749 reintroduced by its
    // own fix.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      suppressNextChange(file);
      rearmWatch(file); // no event was delivered to the old handle

      handles[1].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it("POSIX re-arm twin: a self-write rename that DID reach the old handle is consumed once", async () => {
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      suppressNextChange(file);
      handles[0].changeHandler!("rename"); // consumed at arrival
      await vi.advanceTimersByTimeAsync(500);
      expect(onChanged).not.toHaveBeenCalled();

      rearmWatch(file);
      handles[1].changeHandler!("rename"); // a genuine external save
      await vi.advanceTimersByTimeAsync(500);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });
});

describe("watcher error listeners and handle identity", () => {
  const file = "/tmp/identity.md";

  it("positive control: an error on the CURRENT handle unwatches the path", () => {
    // The file has never had one. Without it `attachWatcher`'s handler could be
    // `() => {}`, or its identity check inverted, and every other case stays
    // green while master's "a watcher that dies loudly is at least gone"
    // behaviour is silently deleted.
    const handles = freshWatcherPerCall();
    watchFile(file, vi.fn().mockResolvedValue(undefined));
    expect(watchedCount()).toBe(1);

    handles[0].errorHandler!(new Error("EBADF"));
    expect(watchedCount()).toBe(0);
  });

  it("a stale error from handle #1 (the INITIAL arm) is ignored after a re-arm", async () => {
    // Handle #1 is the one that goes stale on every POSIX save. Routing only
    // the re-arm sites through `attachWatcher` and leaving `watchFile`'s inline
    // handler as master had it passes every other case here — and ships a
    // queued `error` on #1 calling `unwatchFile` on a live, freshly-armed
    // entry: #1749's symptom with none of its signal.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      watchFile(file, vi.fn().mockResolvedValue(undefined));

      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);
      expect(handles).toHaveLength(2);

      handles[0].errorHandler!(new Error("EBADF"));
      expect(watchedCount()).toBe(1);
    } finally {
      restorePlatform();
    }
  });

  it("a stale error from handle #2 (a RE-ARMED handle) is ignored after the next re-arm", async () => {
    // Copying `watchFile`'s own inline shape into the re-arm rather than
    // calling `attachWatcher` satisfies the row-B `on("error")` assertion and
    // the handle-#1 case above; what it omits is the identity check on #2.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      watchFile(file, vi.fn().mockResolvedValue(undefined));

      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);
      handles[1].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);
      expect(handles).toHaveLength(3);

      handles[1].errorHandler!(new Error("EBADF"));
      expect(watchedCount()).toBe(1);
    } finally {
      restorePlatform();
    }
  });

  it("swapHandle STORES the new handle before closing the old: re-entrant defence only", () => {
    // **This shape is NOT reachable in production, and the case does not claim
    // it is.** Node 24's `FSWatcher.close()` emits only `close`, on
    // `nextTick`; `error` has one emission site, the constructor's libuv
    // `onchange`, which is never entered from inside a `close()` frame, and
    // `close()` nulls `_handle`. `attachWatcher`'s own docstring says exactly
    // that. `swapHandle` is also synchronous end-to-end and both call sites
    // reach it synchronously, so a real event-loop-delivered error on `old`
    // lands after it returns, when the map holds `next` under EITHER ordering.
    //
    // So this is defence-in-depth against a future re-entrant caller, not a
    // regression pin for a live bug — and it should not be read as evidence
    // that the store order protects the identity check, which was a genuine
    // overclaim in the source docstrings until this round corrected them. The
    // real reason for store-before-close is reachability by `unwatchFile`, and
    // the existing row-A call-order case is what pins the half that matters.
    //
    // Kept because it costs nothing and the mutant does die on it — though by
    // recursing `unwatchFile` → mock `close()` → `errorHandler` into a caught
    // `RangeError`, which is itself a property of the mock rather than of Node.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      watchFile(file, vi.fn().mockResolvedValue(undefined));
      handles[0].close.mockImplementation(() => {
        handles[0].closed = true;
        handles[0].errorHandler!(new Error("EBADF"));
      });

      rearmWatch(file);

      expect(handles).toHaveLength(2);
      expect(watchedCount()).toBe(1);
      expect(handles[1].closed).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it("the handle rearmWatch ITSELF mints carries the listener and the identity check", () => {
    // Every other error-listener case here is DELIVERY-driven. Routing the
    // delivery path through `attachWatcher` while inlining a bare
    // `fs.watch(filePath, entry.cb)` inside `rearmWatch` satisfies all of them
    // — and ships a listener-less FSWatcher on every POSIX save, whose first
    // `error` (EBADF, inotify ENOSPC) is an `uncaughtException` →
    // `handleFatalError` → `process.exit(1)`.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      watchFile(file, vi.fn().mockResolvedValue(undefined));

      rearmWatch(file);
      rearmWatch(file);
      expect(handles).toHaveLength(3);

      expect(handles[1].on).toHaveBeenCalledWith("error", expect.any(Function));
      handles[1].errorHandler!(new Error("EBADF"));
      expect(watchedCount()).toBe(1);
    } finally {
      restorePlatform();
    }
  });
});

describe("delivery-time stat: missing file, attach failures and stale verdicts", () => {
  const file = "/tmp/deliver.md";

  it("POSIX: an attach failure on the PRESENT branch reports one lost watch and unwatches", async () => {
    stubPlatform("linux");
    const rejectionSpy = vi.fn();
    process.once("unhandledRejection", rejectionSpy);
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      // EMFILE, not ENOENT: `fs.watch` on POSIX throws EMFILE and ENOSPC
      // (inotify max_user_watches, the commonest Linux watcher failure), and an
      // errno-narrowed guard rethrows into a `setTimeout(async …)` body whose
      // rejection is an `unhandledRejection` → `process.exit(1)`.
      mockWatch.mockImplementationOnce(() => {
        throw emfile();
      });
      statQueue.push(PRESENT());
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      expect(lostWatchNotifications(file)).toHaveLength(1);
      expect(lostWatchNotifications(file)[0].severity).toBe("warning");
      expect(watchedCount()).toBe(0);
      // The `return` is asserted, not merely written. Without it control falls
      // into `isSelfWriteEcho` (entry already deleted → false) and then
      // `onChanged`, producing a false "Failed to reload" toast on a clean doc
      // or a stuck `external-edit` conflict on a dirty one — with every other
      // assertion here still green.
      expect(onChanged).not.toHaveBeenCalled();

      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(rejectionSpy).not.toHaveBeenCalled();
    } finally {
      // Unconditional: `process.once` fires only if a rejection happens, so on
      // the PASSING path the listener leaks — and vitest's own worker handler
      // bails with "assume it is handled by user code" when a second listener
      // is present, turning every later unhandled rejection in this file from a
      // red run into a silent green one.
      process.off("unhandledRejection", rejectionSpy);
      restorePlatform();
    }
  });

  it("POSIX: an attach failure on the MISSING branch reports one lost watch and unwatches", async () => {
    // The twin the present-branch case cannot cover: before this existed the
    // missing branch's own catch had no case at all, and an `else throw` there
    // reaches `process.exit(1)` on the commonest Linux watcher failure.
    stubPlatform("linux");
    const rejectionSpy = vi.fn();
    process.once("unhandledRejection", rejectionSpy);
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      mockWatch.mockImplementationOnce(() => {
        throw emfile();
      });
      statQueue.push(rejected(enoent()));
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      expect(lostWatchNotifications(file)).toHaveLength(1);
      expect(watchedCount()).toBe(0);
      expect(onChanged).not.toHaveBeenCalled();

      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(rejectionSpy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", rejectionSpy);
      restorePlatform();
    }
  });

  it("win32: a missing file is not a lost watch — no notification, entry retained", async () => {
    stubPlatform("win32");
    try {
      expect(process.platform).toBe("win32");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      statQueue.push(rejected(enoent()));
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      expect(lostWatchNotifications(file)).toHaveLength(0);
      expect(watchedCount()).toBe(1);
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it("a stale ENOENT resolving AFTER a later delivery re-armed is discarded silently", async () => {
    // Delete-then-recreate where delivery 1's stat is SLOWER than delivery 2's.
    // The entry re-check is blind to this: a re-arm mutates `entry.watcher` IN
    // PLACE and never replaces the entry, so delivery 1's stale ENOENT would
    // pass it and fire the warn, the toast and `unwatchFile` on a live,
    // freshly re-armed handle. `armedAt` is what catches it.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      const slow = deferred<unknown>();
      statQueue.push(slow.promise);
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500); // delivery 1 parks on its stat

      statQueue.push(PRESENT());
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500); // delivery 2 re-arms in place

      expect(mockWatch).toHaveBeenCalledTimes(2);

      slow.reject(enoent()); // delivery 1's verdict, now stale
      await vi.advanceTimersByTimeAsync(1);

      expect(lostWatchNotifications(file)).toHaveLength(0);
      expect(watchedCount()).toBe(1);
      // initial arm + the ONE re-arm, and no probe handle
      expect(mockWatch).toHaveBeenCalledTimes(2);
    } finally {
      restorePlatform();
    }
  });

  it("the mirror ordering (stale PRESENT, later ENOENT) still reports exactly one lost watch", async () => {
    // Delivery 1 resolves present but slowly and delivery 2's ENOENT is slower
    // still. The file really IS deleted here, so the mock's second `fs.watch`
    // throws: the stale-present attach takes the missing arm itself, and
    // delivery 2 then finds the entry gone and discards. Without the total
    // wrap on the attach this is zero notifications and a `watched` entry that
    // never recovers.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      const d1 = deferred<unknown>();
      statQueue.push(d1.promise);
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      const d2 = deferred<unknown>();
      statQueue.push(d2.promise);
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      mockWatch.mockImplementationOnce(() => {
        throw emfile();
      });
      d1.resolve({ isFile: () => true });
      await vi.advanceTimersByTimeAsync(1);
      d2.reject(enoent());
      await vi.advanceTimersByTimeAsync(1);

      expect(lostWatchNotifications(file)).toHaveLength(1);
      expect(watchedCount()).toBe(0);
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it("an unwatchFile during the delivery stat attaches no handle and skips the content path", async () => {
    // Emitted as a `rename` under the linux stub deliberately: on a `change`,
    // or under win32, no attach happens with or without the re-check, so the
    // "no handle attached" half would be vacuous.
    stubPlatform("linux");
    try {
      expect(process.platform).toBe("linux");
      const handles = freshWatcherPerCall();
      const onChanged = vi.fn().mockResolvedValue(undefined);
      watchFile(file, onChanged);

      const pending = deferred<unknown>();
      statQueue.push(pending.promise);
      handles[0].changeHandler!("rename");
      await vi.advanceTimersByTimeAsync(500);

      unwatchFile(file); // tab close / rename, mid-body
      pending.resolve({ isFile: () => true });
      await vi.advanceTimersByTimeAsync(1);

      expect(mockWatch).toHaveBeenCalledTimes(1);
      expect(onChanged).not.toHaveBeenCalled();
      expect(watchedCount()).toBe(0);
    } finally {
      restorePlatform();
    }
  });
});
