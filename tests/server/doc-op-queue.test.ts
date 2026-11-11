import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  docOpQueueSizeForTests,
  isDocOpQueueBusy,
  resetDocOpQueuesForTests,
  runDocOp,
  runWhenDocIdle,
} from "../../src/server/sessions/doc-op-queue.js";

/**
 * The per-document operation queue (#2358, ADR-054; ownership design §5.1).
 * Pure: it reads no flag. What calls it, and only with ownership on, is pinned
 * in `ownership-dark-enforcement.test.ts`.
 */

afterEach(() => resetDocOpQueuesForTests());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runDocOp", () => {
  it("runs one document's operations one at a time, in call order", async () => {
    const gate = deferred();
    const log: string[] = [];
    const first = runDocOp("d", async () => {
      log.push("first:start");
      await gate.promise;
      log.push("first:end");
    });
    const second = runDocOp("d", () => {
      log.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not hold one document behind another", async () => {
    const gate = deferred();
    const blocked = runDocOp("a", () => gate.promise);
    await expect(runDocOp("b", () => "ran")).resolves.toBe("ran");
    gate.resolve();
    await blocked;
  });

  it("a rejected or throwing operation fails its own caller and the next one still runs", async () => {
    const failing = runDocOp("d", () => {
      throw new Error("boom");
    });
    const rejecting = runDocOp("d", () => Promise.reject(new Error("no")));
    const after = runDocOp("d", () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(rejecting).rejects.toThrow("no");
    await expect(after).resolves.toBe("ok");
  });

  it("an operation queued from inside another's synchronous head waits for it", async () => {
    // Reachable through a claim: writing an entry can re-judge a record,
    // which can lapse another, which queues an ownership change.
    const gate = deferred();
    const log: string[] = [];
    let nested: Promise<void> | undefined;
    const outer = runDocOp("d", async () => {
      log.push("outer:start");
      nested = runDocOp("d", () => {
        log.push("nested");
      });
      runWhenDocIdle(
        "d",
        () => log.push("change"),
        () => undefined,
      );
      await gate.promise;
      log.push("outer:end");
    });
    const after = runDocOp("d", () => {
      log.push("after");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["outer:start"]);
    gate.resolve();
    await Promise.all([outer, nested, after]);
    await runDocOp("d", () => undefined);
    expect(log).toEqual(["outer:start", "outer:end", "nested", "change", "after"]);
    expect(isDocOpQueueBusy("d")).toBe(false);
  });

  it("forgets a document once its last operation settles, including one that failed", async () => {
    await runDocOp("d", () => undefined);
    await runDocOp("never-opened", () => Promise.reject(new Error("x"))).catch(() => undefined);
    await Promise.resolve();
    expect(isDocOpQueueBusy("d")).toBe(false);
    expect(docOpQueueSizeForTests()).toBe(0);
  });

  it("runs each operation in the async context of the call that queued it", async () => {
    // `wakeUrlField()` reads the request's `peerIsLoopback` from the ambient
    // context; a shared drain loop would hand every body the first caller's.
    const store = new AsyncLocalStorage<string>();
    const gate = deferred();
    const seen: Array<string | undefined> = [];
    const first = store.run("first", () =>
      runDocOp("d", async () => {
        await gate.promise;
        seen.push(store.getStore());
      }),
    );
    const second = store.run("second", () => runDocOp("d", () => void seen.push(store.getStore())));
    gate.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual(["first", "second"]);
  });
});

describe("runWhenDocIdle", () => {
  it("runs at once when nothing is in flight", () => {
    let ran = false;
    runWhenDocIdle(
      "d",
      () => {
        ran = true;
      },
      () => undefined,
    );
    expect(ran).toBe(true);
    expect(isDocOpQueueBusy("d")).toBe(false);
  });

  it("waits for the running operation, and reports a throw instead of losing it", async () => {
    const gate = deferred();
    const log: string[] = [];
    const errors: unknown[] = [];
    const op = runDocOp("d", async () => {
      await gate.promise;
      log.push("op");
    });
    runWhenDocIdle(
      "d",
      () => log.push("change"),
      (err) => errors.push(err),
    );
    runWhenDocIdle(
      "d",
      () => {
        throw new Error("late");
      },
      (err) => errors.push(err),
    );
    expect(log).toEqual([]);
    gate.resolve();
    await op;
    await runDocOp("d", () => undefined);
    expect(log).toEqual(["op", "change"]);
    expect(errors.map(String)).toEqual(["Error: late"]);
  });
});
