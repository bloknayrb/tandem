import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOC_OP_WAIT_MS,
  DocOpCancelled,
  DocOpWaitExpired,
  docOpQueueSizeForTests,
  isDocOpQueueBusy,
  resetDocOpQueuesForTests,
  runDocOp,
  runWhenDocIdle,
} from "../../src/server/sessions/doc-op-queue.js";
import { STDIO_BRIDGE_REQUEST_TIMEOUT_MS } from "../../src/shared/constants.js";

/**
 * The per-document operation queue (#2358, ADR-054; ownership design §5.1).
 * Pure: it reads no flag. What calls it, and only with ownership on, is pinned
 * in `ownership-dark-enforcement.test.ts`.
 */

afterEach(() => {
  resetDocOpQueuesForTests();
  vi.useRealTimers();
});

/** Let every queued promise callback run. Works under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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

describe("the wait bound (Bryan, 2026-11-11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("the limit sits well below the stdio bridge's own request timeout", () => {
    // The bridge gives up at its timeout without telling the server. A call
    // still waiting then must already have been refused here, with room for
    // the refusal to travel back.
    // Read from the shared constant, never from the bridge module: loading
    // that installs process-level handlers in this worker.
    expect(DOC_OP_WAIT_MS).toBeLessThanOrEqual((STDIO_BRIDGE_REQUEST_TIMEOUT_MS * 2) / 3);
  });

  it("a call that waits past the limit is refused, never runs, and leaves no queue entry", async () => {
    const head = deferred();
    let ran = false;
    const first = runDocOp("d", () => head.promise);
    const waiting = runDocOp("d", () => {
      ran = true;
    });
    const refused = expect(waiting).rejects.toBeInstanceOf(DocOpWaitExpired);

    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    expect(ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    await expect(waiting).rejects.toMatchObject({ waitedMs: DOC_OP_WAIT_MS });
    // The head is still running: the document is busy on its account alone.
    expect(isDocOpQueueBusy("d")).toBe(true);

    head.resolve();
    await first;
    await flush();
    // Its turn came and went: it did not run, and nothing is left behind.
    expect(ran).toBe(false);
    expect(isDocOpQueueBusy("d")).toBe(false);
    expect(docOpQueueSizeForTests()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the next call after an expiry still runs in order, and only after the head", async () => {
    const head = deferred();
    const log: string[] = [];
    const first = runDocOp("d", async () => {
      await head.promise;
      log.push("head");
    });
    const expired = runDocOp("d", () => void log.push("expired"));
    expired.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 5000);
    // Queued behind the entrant that is about to give up.
    const later = runDocOp("d", () => void log.push("later"));
    const last = runDocOp("d", () => void log.push("last"));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(expired).rejects.toBeInstanceOf(DocOpWaitExpired);
    // The expiry opened nothing: the head is still the only thing that ran.
    await flush();
    expect(log).toEqual([]);

    head.resolve();
    await Promise.all([first, later, last]);
    expect(log).toEqual(["head", "later", "last"]);
    expect(isDocOpQueueBusy("d")).toBe(false);
  });

  it("a call whose turn comes just inside the limit runs, and its timer is cleared", async () => {
    const head = deferred();
    const first = runDocOp("d", () => head.promise);
    const waiting = runDocOp("d", () => "ran");
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    head.resolve();
    await first;
    await expect(waiting).resolves.toBe("ran");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
    expect(isDocOpQueueBusy("d")).toBe(false);
  });

  it("a turn that comes after the limit, before the timer could fire, is still refused", async () => {
    // The turn is a promise callback and the expiry a timer, so after a long
    // synchronous stretch the turn can come first. The clock decides.
    const head = deferred();
    let ran = false;
    const first = runDocOp("d", () => head.promise);
    const waiting = runDocOp("d", () => {
      ran = true;
    });
    const refused = expect(waiting).rejects.toBeInstanceOf(DocOpWaitExpired);
    // The clock passes the limit without any timer running.
    vi.setSystemTime(Date.now() + DOC_OP_WAIT_MS + 5000);
    head.resolve();
    await first;
    await refused;
    expect(ran).toBe(false);
    expect(isDocOpQueueBusy("d")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a running operation is never cancelled, however long it takes", async () => {
    const head = deferred<string>();
    const first = runDocOp("d", () => head.promise);
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS * 10);
    head.resolve("finished");
    await expect(first).resolves.toBe("finished");
  });

  it("an idle document starts at once and arms no timer", () => {
    let ran = false;
    void runDocOp("d", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a call whose request was aborted by its turn is skipped, and the one behind it runs", async () => {
    const head = deferred();
    const abort = new AbortController();
    const log: string[] = [];
    const first = runDocOp("d", () => head.promise);
    const cancelled = runDocOp("d", () => void log.push("cancelled"), { signal: abort.signal });
    const after = runDocOp("d", () => void log.push("after"));
    const refused = expect(cancelled).rejects.toBeInstanceOf(DocOpCancelled);
    abort.abort();
    // Aborting does not jump the queue or free the slot early.
    await flush();
    expect(log).toEqual([]);
    head.resolve();
    await first;
    await refused;
    await after;
    expect(log).toEqual(["after"]);
    expect(isDocOpQueueBusy("d")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a signal that is not aborted changes nothing", async () => {
    const head = deferred();
    const first = runDocOp("d", () => head.promise);
    const waiting = runDocOp("d", () => "ran", { signal: new AbortController().signal });
    head.resolve();
    await first;
    await expect(waiting).resolves.toBe("ran");
  });

  it("a shorter wait can be asked for, and is what the refusal reports", async () => {
    const head = deferred();
    const first = runDocOp("d", () => head.promise);
    const waiting = runDocOp("d", () => "ran", { waitMs: 250 });
    const refused = expect(waiting).rejects.toMatchObject({ waitedMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    await refused;
    head.resolve();
    await first;
  });

  it("a new call arriving in the tick the head settles runs once, after it, with expired entrants still unopened", async () => {
    const head = deferred();
    const log: string[] = [];
    const first = runDocOp("d", async () => {
      await head.promise;
      log.push("head");
    });
    const expired = runDocOp("d", () => void log.push("expired"));
    expired.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
    head.resolve();
    await first;
    // Same tick as the head's settlement: the expired entrant's gate may not
    // have opened yet, and the chain may already be forgotten.
    const fresh = runDocOp("d", () => void log.push("fresh"));
    await fresh;
    await flush();
    expect(log).toEqual(["head", "fresh"]);
    expect(isDocOpQueueBusy("d")).toBe(false);
  });

  it("a waiting call still runs in the async context of the call that queued it", async () => {
    const store = new AsyncLocalStorage<string>();
    const head = deferred();
    const seen: Array<string | undefined> = [];
    const first = store.run("first", () => runDocOp("d", () => head.promise));
    const second = store.run("second", () => runDocOp("d", () => void seen.push(store.getStore())));
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    head.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual(["second"]);
  });

  describe("runWhenDocIdle", () => {
    it("runs the change at the limit, out of turn, once — and not again at its turn", async () => {
      const head = deferred();
      let runs = 0;
      const errors: unknown[] = [];
      const first = runDocOp("d", () => head.promise);
      runWhenDocIdle(
        "d",
        () => {
          runs++;
        },
        (err) => errors.push(err),
      );
      await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toBe(1);
      head.resolve();
      await first;
      await flush();
      expect(runs).toBe(1);
      expect(errors).toEqual([]);
      expect(isDocOpQueueBusy("d")).toBe(false);
    });

    it("a turn that comes late runs the change before the next entrant's turn", async () => {
      // The late-turn path (the clock passed the limit, the timer has not
      // fired): the change must land before the entrant behind it reads the
      // state, or that entrant would be refused on the strength of an owner
      // that is about to be moved.
      const head = deferred();
      const log: string[] = [];
      const first = runDocOp("d", () => head.promise);
      runWhenDocIdle(
        "d",
        () => void log.push("change"),
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 5000);
      const successor = runDocOp("d", () => void log.push("successor"));
      // Past the change's limit, well inside the successor's, no timer run.
      vi.setSystemTime(Date.now() + 6000);
      head.resolve();
      await first;
      await successor;
      expect(log).toEqual(["change", "successor"]);
      await flush();
      expect(log).toEqual(["change", "successor"]);
    });

    it("a change that throws at the limit is reported, not lost and not unhandled", async () => {
      const head = deferred();
      const errors: unknown[] = [];
      const first = runDocOp("d", () => head.promise);
      runWhenDocIdle(
        "d",
        () => {
          throw new Error("late");
        },
        (err) => errors.push(err),
      );
      await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
      expect(errors.map(String)).toEqual(["Error: late"]);
      head.resolve();
      await first;
    });
  });
});
