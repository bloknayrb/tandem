/**
 * Tests for the durable annotation store.
 *
 * Every test gets its own tempdir via `TANDEM_APP_DATA_DIR`. We also call
 * `resetForTesting()` before each test so the module-level maps (debounce
 * timers, failure counters, disabled docs, readonly flag) don't bleed.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notifications are a shared singleton buffer; reset between tests and spy
// on pushNotification so we can assert on failure-mode behaviour.
vi.mock("../../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

import {
  type AnnotationDocV1,
  migrateToV1,
  SCHEMA_VERSION,
} from "../../../src/server/annotations/schema.js";
import {
  acquireStoreLock,
  closeStore,
  createStore,
  getAnnotationsDir,
  releaseStoreLock,
  resetForTesting,
} from "../../../src/server/annotations/store.js";
import { pushNotification } from "../../../src/server/notifications.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const FILE_A = "/virtual/doc-a.md";
const FILE_B = "/virtual/doc-b.md";

function makeDoc(
  docHash: string,
  filePath: string,
  overrides: Partial<AnnotationDocV1> = {},
): AnnotationDocV1 {
  const base = migrateToV1({});
  base.docHash = docHash;
  base.meta = { filePath, lastUpdated: Date.now() };
  return { ...base, ...overrides };
}

let tmpRoot: string;
let prevAppDataDir: string | undefined;
let prevFeatureFlag: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-store-test-"));
  prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  prevFeatureFlag = process.env.TANDEM_ANNOTATION_STORE;
  process.env.TANDEM_APP_DATA_DIR = tmpRoot;
  delete process.env.TANDEM_ANNOTATION_STORE; // default = on
  resetForTesting();
  vi.mocked(pushNotification).mockClear();
});

afterEach(async () => {
  resetForTesting();
  if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
  if (prevFeatureFlag === undefined) delete process.env.TANDEM_ANNOTATION_STORE;
  else process.env.TANDEM_ANNOTATION_STORE = prevFeatureFlag;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #1 fresh load
// ---------------------------------------------------------------------------

describe("createStore + load", () => {
  it("returns an empty migrated doc when no file exists", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.annotations).toEqual([]);
    expect(loaded.replies).toEqual([]);
    expect(loaded.tombstones).toEqual([]);
    expect(loaded.docHash).toBe(HASH_A);
    expect(loaded.meta.filePath).toBe(FILE_A);
  });
});

// ---------------------------------------------------------------------------
// #2 round trip
// ---------------------------------------------------------------------------

describe("queueWrite + flush round-trip", () => {
  it("persists a written doc and round-trips through load", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const doc = makeDoc(HASH_A, FILE_A, {
      annotations: [
        {
          id: "ann_1",
          author: "claude",
          type: "comment",
          range: { from: 0, to: 5 },
          content: "hi",
          status: "pending",
          timestamp: 1_700_000_000_000,
          rev: 1,
        },
      ],
    });

    store.queueWrite(() => doc);
    await store.flush();

    const onDisk = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    expect(JSON.parse(onDisk)).toMatchObject({
      schemaVersion: 1,
      docHash: HASH_A,
      annotations: [{ id: "ann_1", rev: 1 }],
    });

    const loaded = await store.load();
    expect(loaded.annotations).toHaveLength(1);
    expect(loaded.annotations[0]?.id).toBe("ann_1");
  });
});

// ---------------------------------------------------------------------------
// #3 debounce coalescing
// ---------------------------------------------------------------------------

describe("debounce coalescing", () => {
  it("3 rapid writes within 100ms produce exactly 1 file I/O", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const writeSpy = vi.spyOn(fs, "writeFile");

    store.queueWrite(() => makeDoc(HASH_A, FILE_A, { annotations: [] }));
    store.queueWrite(() =>
      makeDoc(HASH_A, FILE_A, {
        annotations: [
          {
            id: "ann_mid",
            author: "claude",
            type: "comment",
            range: { from: 0, to: 1 },
            content: "",
            status: "pending",
            timestamp: 1,
            rev: 1,
          },
        ],
      }),
    );
    store.queueWrite(() =>
      makeDoc(HASH_A, FILE_A, {
        annotations: [
          {
            id: "ann_last",
            author: "claude",
            type: "comment",
            range: { from: 0, to: 2 },
            content: "",
            status: "pending",
            timestamp: 2,
            rev: 1,
          },
        ],
      }),
    );

    await store.flush();

    // Exactly one writeFile call (the atomicWrite temp-write).
    // Other test-helper reads don't call writeFile so the spy count is clean.
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // And we kept the latest payload.
    const reloaded = await store.load();
    expect(reloaded.annotations).toHaveLength(1);
    expect(reloaded.annotations[0]?.id).toBe("ann_last");
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #4 per-doc debounce (not global)
// ---------------------------------------------------------------------------

describe("per-doc debounce", () => {
  it("parallel writes to two docs both produce files", async () => {
    const storeA = createStore(HASH_A, { filePath: FILE_A });
    const storeB = createStore(HASH_B, { filePath: FILE_B });

    storeA.queueWrite(() => makeDoc(HASH_A, FILE_A));
    storeB.queueWrite(() => makeDoc(HASH_B, FILE_B));

    await Promise.all([storeA.flush(), storeB.flush()]);

    const files = await fs.readdir(path.join(tmpRoot, "annotations"));
    expect(files).toContain(`${HASH_A}.json`);
    expect(files).toContain(`${HASH_B}.json`);
  });
});

// ---------------------------------------------------------------------------
// #5 corrupt file on load
// ---------------------------------------------------------------------------

describe("corrupt file on load", () => {
  it("returns empty doc and quarantines the file", async () => {
    const annotationsDir = getAnnotationsDir();
    await fs.mkdir(annotationsDir, { recursive: true });
    const target = path.join(annotationsDir, `${HASH_A}.json`);
    await fs.writeFile(target, "}{ not json at all");

    const store = createStore(HASH_A, { filePath: FILE_A });
    const loaded = await store.load();
    expect(loaded.annotations).toEqual([]);

    const files = await fs.readdir(annotationsDir);
    const corrupted = files.find((f) => f.startsWith(`${HASH_A}.json.corrupt.`));
    expect(corrupted).toBeDefined();
    // Original file is gone (renamed).
    expect(files).not.toContain(`${HASH_A}.json`);
  });
});

// ---------------------------------------------------------------------------
// #6 future-schema file on load
// ---------------------------------------------------------------------------

describe("future-schema file on load", () => {
  it("returns empty doc and parks the file at .future without timestamp", async () => {
    const annotationsDir = getAnnotationsDir();
    await fs.mkdir(annotationsDir, { recursive: true });
    const target = path.join(annotationsDir, `${HASH_A}.json`);
    await fs.writeFile(target, JSON.stringify({ schemaVersion: 2, something: "newer" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const loaded = await store.load();
    expect(loaded.annotations).toEqual([]);

    const files = await fs.readdir(annotationsDir);
    expect(files).toContain(`${HASH_A}.json.future`);
    expect(files).not.toContain(`${HASH_A}.json`);

    // No toast for future (expected during downgrade).
    expect(pushNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #7 lock held by live PID
// ---------------------------------------------------------------------------

describe("lock held by live PID", () => {
  it("returns readonly and queueWrite is a no-op", async () => {
    const annotationsDir = getAnnotationsDir();
    await fs.mkdir(annotationsDir, { recursive: true });
    await fs.writeFile(path.join(annotationsDir, "store.lock"), String(process.pid));

    const result = await acquireStoreLock();
    expect(result).toBe("readonly");

    const store = createStore(HASH_A, { filePath: FILE_A });
    expect(store.isReadOnly()).toBe(true);

    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await store.flush();

    // File should not have been created.
    const files = await fs.readdir(annotationsDir);
    expect(files).not.toContain(`${HASH_A}.json`);

    await releaseStoreLock();
  });
});

// ---------------------------------------------------------------------------
// #8 lock held by dead PID
// ---------------------------------------------------------------------------

describe("lock held by dead PID", () => {
  it("reclaims the stale lock and proceeds", async () => {
    const annotationsDir = getAnnotationsDir();
    await fs.mkdir(annotationsDir, { recursive: true });
    // 999999999 is safely outside any platform PID range.
    await fs.writeFile(path.join(annotationsDir, "store.lock"), "999999999");

    const result = await acquireStoreLock();
    expect(result).toBe("locked");

    // Lock file should now contain our PID.
    const lockContents = await fs.readFile(path.join(annotationsDir, "store.lock"), "utf-8");
    expect(lockContents.trim()).toBe(String(process.pid));

    await releaseStoreLock();
  });
});

// ---------------------------------------------------------------------------
// #9 disk-full / write failure disables after 3 consecutive
// ---------------------------------------------------------------------------

describe("write failure → throttled notify → disable after 3", () => {
  it("emits throttled notifications and disables the doc after 3 failures", async () => {
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValue(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const notify = vi.mocked(pushNotification);

    // Attempt 1 — transient failure, 1 notification.
    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await expect(store.flush()).rejects.toThrow();
    expect(store.isDisabled(HASH_A)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    // Attempt 2 — within the 60s window, throttled (no new notification).
    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await expect(store.flush()).rejects.toThrow();
    expect(store.isDisabled(HASH_A)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1); // throttled

    // Attempt 3 — third consecutive failure flips to "persistent" and disables.
    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await expect(store.flush()).rejects.toThrow();
    expect(store.isDisabled(HASH_A)).toBe(true);
    // Persistent notification bypasses the throttle.
    expect(notify).toHaveBeenCalledTimes(2);

    // Attempt 4 — disabled: queueWrite is a no-op; writeFile not called again.
    const prevWriteCount = writeSpy.mock.calls.length;
    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await store.flush();
    expect(writeSpy.mock.calls.length).toBe(prevWriteCount);
    // Still exactly 2 notifications total (no extras once disabled).
    expect(notify).toHaveBeenCalledTimes(2);

    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #10 feature flag off
// ---------------------------------------------------------------------------

describe("TANDEM_ANNOTATION_STORE=off", () => {
  it("returns inert store: load gives empty, writes are no-ops", async () => {
    process.env.TANDEM_ANNOTATION_STORE = "off";
    const store = createStore(HASH_A, { filePath: FILE_A });
    expect(store.isReadOnly()).toBe(false);

    const loaded = await store.load();
    expect(loaded.annotations).toEqual([]);
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);

    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await store.flush();
    await store.clear();

    // No annotations dir should have been created.
    const annotationsDir = path.join(tmpRoot, "annotations");
    await expect(fs.readdir(annotationsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// #11 clear
// ---------------------------------------------------------------------------

describe("clear()", () => {
  it("deletes the file and is idempotent", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    store.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await store.flush();

    const target = path.join(tmpRoot, "annotations", `${HASH_A}.json`);
    await fs.access(target); // exists

    await store.clear();
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });

    // Idempotent — second clear doesn't throw.
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #12 TANDEM_APP_DATA_DIR honored
// ---------------------------------------------------------------------------

describe("getAnnotationsDir override", () => {
  it("honors TANDEM_APP_DATA_DIR", () => {
    const custom = path.join(os.tmpdir(), `tandem-store-override-${crypto.randomUUID()}`);
    process.env.TANDEM_APP_DATA_DIR = custom;
    expect(getAnnotationsDir()).toBe(path.join(custom, "annotations"));
  });
});

// ---------------------------------------------------------------------------
// #13 closeStore: per-doc lifecycle cleanup
// ---------------------------------------------------------------------------

describe("closeStore", () => {
  it("flushes pending writes, clears transient state, preserves disabled/persistent flags", async () => {
    // First: a healthy doc that had a pending write. closeStore should flush it
    // and evict the (absent) failure state entry entirely.
    const storeA = createStore(HASH_A, { filePath: FILE_A });
    storeA.queueWrite(() => makeDoc(HASH_A, FILE_A));
    await closeStore(HASH_A);
    // The pending write flushed as part of close.
    const aFiles = await fs.readdir(path.join(tmpRoot, "annotations"));
    expect(aFiles).toContain(`${HASH_A}.json`);

    // Second: drive storeB into the disabled state via 3 consecutive failures,
    // then closeStore(B) and verify the disabled flag survives (i.e. the doc
    // stays disabled, matching the "restart to retry" UX).
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValue(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    const storeB = createStore(HASH_B, { filePath: FILE_B });
    for (let i = 0; i < 3; i++) {
      storeB.queueWrite(() => makeDoc(HASH_B, FILE_B));
      await expect(storeB.flush()).rejects.toThrow();
    }
    expect(storeB.isDisabled(HASH_B)).toBe(true);

    await closeStore(HASH_B);
    // Disabled flag MUST survive close.
    expect(storeB.isDisabled(HASH_B)).toBe(true);

    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Thunk-throw isolation: a snapshot function that throws MUST NOT escape the
// timer or flush boundary. If it did, it would hit uncaughtException in
// index.ts and kill the whole server — a per-doc save bug must not take the
// process down.
// ---------------------------------------------------------------------------

describe("queueWrite thunk that throws", () => {
  it("debounce path: routes to recordFailure; no process crash; no file written", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const boom = () => {
      throw new Error("simulated snapshot failure");
    };
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      store.queueWrite(boom);
      // Wait past the debounce window so the timer fires.
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      process.off("uncaughtException", uncaught);
    }

    // The timer must have absorbed the throw.
    expect(uncaught).not.toHaveBeenCalled();
    // Failure routed through pushNotification (one transient call).
    expect(pushNotification).toHaveBeenCalled();
    // And no file should have landed on disk.
    await expect(
      fs.access(path.join(tmpRoot, "annotations", `${HASH_A}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("flush path: rethrows to caller but still routes through recordFailure", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const boom = () => {
      throw new Error("simulated flush-time failure");
    };

    store.queueWrite(boom);
    await expect(store.flush()).rejects.toThrow("simulated flush-time failure");
    // recordFailure was hit, so pushNotification fired once.
    expect(pushNotification).toHaveBeenCalled();
  });
});
