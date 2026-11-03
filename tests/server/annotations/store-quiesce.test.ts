/**
 * `quiesceForTesting` (#2347, #2289): a test teardown must be able to wait for
 * every store write still running before it removes the store's directory.
 * `resetForTesting` used to drop the promises of writes already in flight, so
 * a reset that ran earlier in the same teardown hid them from any later wait.
 *
 * Each `atomicWrite` the store makes parks on its own gate until the test
 * releases it, so "still running" is a state the test holds, not a race.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gates = vi.hoisted(() => ({
  parked: [] as Array<() => void>,
  park: false,
}));

vi.mock(import("../../../src/server/file-io/index.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    atomicWrite: vi.fn(async (...args: Parameters<typeof actual.atomicWrite>) => {
      if (gates.park) await new Promise<void>((resolve) => gates.parked.push(resolve));
      return actual.atomicWrite(...args);
    }),
  };
});

vi.mock(import("../../../src/server/notifications.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  pushNotification: vi.fn(),
}));

// Same reason as sync.test.ts: the store's fire-and-forget ACL run on a fresh
// `annotations/` holds it on Windows. Nothing here tests ACLs.
vi.mock(import("../../../src/server/integrations/acl-win.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import {
  createStore,
  quiesceForTesting,
  resetForTesting,
} from "../../../src/server/annotations/store.js";
import {
  FILE_A,
  FILE_B,
  HASH_A,
  HASH_B,
  makeAnnotationDoc,
} from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";

useTmpAnnotationsEnvWithFlag("tandem-store-quiesce-");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `n` writes are parked on their gates. */
async function untilParked(n: number): Promise<void> {
  for (let i = 0; i < 200 && gates.parked.length < n; i++) await tick(5);
  expect(gates.parked.length).toBe(n);
}

function releaseAll(): void {
  gates.park = false;
  for (const release of gates.parked.splice(0)) release();
}

/** Resolves to true once `p` settles; read it after a short wait. */
function settledFlag(p: Promise<unknown>): { done: boolean } {
  const flag = { done: false };
  void p.then(
    () => {
      flag.done = true;
    },
    () => {
      flag.done = true;
    },
  );
  return flag;
}

beforeEach(() => {
  resetForTesting();
  gates.park = false;
  gates.parked.length = 0;
});

afterEach(() => {
  // Never leave a write parked: the helper's own quiesce would wait on it.
  releaseAll();
});

describe("quiesceForTesting", () => {
  it("returns at once when nothing is running", async () => {
    await expect(quiesceForTesting()).resolves.toBeUndefined();
  });

  it("waits for a write that was in flight when resetForTesting forgot it", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    gates.park = true;
    store.queueWrite(() => makeAnnotationDoc(HASH_A, FILE_A));
    const flushed = store.flush().catch(() => {});
    await untilParked(1);

    resetForTesting(); // the teardown-order case: a file-level reset ran first
    const quiesced = settledFlag(quiesceForTesting());
    await tick(50);
    expect(quiesced.done, "quiesce returned while the write still held the directory").toBe(false);

    releaseAll();
    await flushed;
    await tick(20);
    expect(quiesced.done).toBe(true);
  });

  it("also waits for a write that starts while it is already waiting", async () => {
    const storeA = createStore(HASH_A, { filePath: FILE_A });
    const storeB = createStore(HASH_B, { filePath: FILE_B });
    gates.park = true;
    storeA.queueWrite(() => makeAnnotationDoc(HASH_A, FILE_A));
    const flushedA = storeA.flush().catch(() => {});
    await untilParked(1);

    const quiesced = settledFlag(quiesceForTesting());
    storeB.queueWrite(() => makeAnnotationDoc(HASH_B, FILE_B));
    const flushedB = storeB.flush().catch(() => {});
    await untilParked(2);

    // Release A only. B is still running, so the quiesce must keep waiting.
    gates.parked.shift()?.();
    await flushedA;
    await tick(50);
    expect(quiesced.done, "quiesce returned with B still writing").toBe(false);

    releaseAll();
    await flushedB;
    await tick(20);
    expect(quiesced.done).toBe(true);
  });

  it("cancels a pending debounced write rather than running it", async () => {
    const store = createStore(HASH_A, { filePath: FILE_A });
    const { atomicWrite } = await import("../../../src/server/file-io/index.js");
    vi.mocked(atomicWrite).mockClear();
    store.queueWrite(() => makeAnnotationDoc(HASH_A, FILE_A));
    await quiesceForTesting();
    await tick(250); // past the debounce
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});
