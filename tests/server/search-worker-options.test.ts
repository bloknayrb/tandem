import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1795 — the parts of the worker's construction that no timing test can see.
 *
 * `vi.mock` is hoisted and file-scoped, so this lives in its own file. Nothing
 * here spawns a thread, which is also why it needs no `shutdownSearchWorker`
 * teardown beyond the `afterEach` that clears module state.
 *
 * The recorder must come from `vi.hoisted`: a plain module-level `const` is in
 * its temporal dead zone when the hoisted factory runs.
 */
const rec = vi.hoisted(() => ({
  events: [] as string[],
  opts: [] as unknown[],
  posted: [] as Array<Record<string, unknown>>,
}));

// The module under test imports the specifier "node:worker_threads" verbatim;
// a bare "worker_threads" or a createRequire shim would silently miss this.
vi.mock("node:worker_threads", () => {
  class FakeWorker {
    stdout = {
      pipe: () => {
        rec.events.push("stdout.pipe");
      },
    };
    stderr = {
      pipe: () => {
        rec.events.push("stderr.pipe");
      },
    };
    constructor(_source: string, options: unknown) {
      rec.events.push("construct");
      rec.opts.push(options);
    }
    on(event: string) {
      rec.events.push(`on:${event}`);
      return this;
    }
    ref() {
      rec.events.push("ref");
    }
    unref() {
      rec.events.push("unref");
    }
    postMessage(message: Record<string, unknown>) {
      rec.events.push("postMessage");
      rec.posted.push(message);
    }
    terminate() {
      rec.events.push("terminate");
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

const { DEFAULT_HARD_TIMEOUT_MS, searchRegexInWorker, shutdownSearchWorker } = await import(
  "../../src/server/mcp/search-worker.js"
);

beforeEach(() => {
  rec.events.length = 0;
  rec.opts.length = 0;
  rec.posted.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  // Clears the in-flight hard timer and drops module state, so each case starts
  // from "no worker". The fake never emits `message`, so every pending request
  // rejects here — the calls below all attach a `.catch`.
  await shutdownSearchWorker();
});

describe("search worker construction", () => {
  it("attaches every listener in the constructing tick, before postMessage", () => {
    searchRegexInWorker("abc", "a").catch(() => {});

    // Read SYNCHRONOUSLY, and with exact equality. That is the whole point: a
    // listener attached inside a `.then()` is simply absent from this array,
    // and `toContain`/index math would not notice. An unlistened Worker `error`
    // throws in the parent, becomes an uncaughtException, and exits the server.
    expect(rec.events).toEqual([
      "construct",
      "on:error",
      "on:exit",
      "on:message",
      "stdout.pipe",
      "stderr.pipe",
      "postMessage",
    ]);
  });

  it("does not auto-pipe the worker's stdio into the parent's", () => {
    searchRegexInWorker("abc", "a").catch(() => {});
    // `stdout: true` reads inverted — it means "give me the stream, do NOT
    // wire it to my own". Critical Rule 3: the console redirect in index.ts is
    // main-thread only, so an auto-piped worker would write to the real fd 1.
    expect(rec.opts[0]).toMatchObject({ eval: true, stdout: true, stderr: true });
  });

  it("dispatches with the 1800 ms in-worker deadline", () => {
    searchRegexInWorker("abc", "a").catch(() => {});
    // With the `elapsed` upper bounds gone from the timing tests, nothing else
    // would stop an 8000/9000 regression from shipping green.
    expect(rec.posted[0]).toMatchObject({ deadlineMs: 1800 });
  });

  it("reuses one worker across requests", () => {
    searchRegexInWorker("abc", "a").catch(() => {});
    searchRegexInWorker("abc", "b").catch(() => {});
    expect(rec.events.filter((e) => e === "construct")).toHaveLength(1);
  });

  it("arms the hard timer at 2000 ms and terminates when it fires", () => {
    vi.useFakeTimers();
    searchRegexInWorker("abc", "a").catch(() => {});
    expect(DEFAULT_HARD_TIMEOUT_MS).toBe(2000);

    vi.advanceTimersByTime(DEFAULT_HARD_TIMEOUT_MS - 1);
    expect(rec.events).not.toContain("terminate");

    vi.advanceTimersByTime(2);
    expect(rec.events).toContain("terminate");
  });
});
