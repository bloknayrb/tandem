import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  searchRegexInWorker,
  shutdownSearchWorker,
  WORKER_SOURCE,
} from "../../src/server/mcp/search-worker.js";

/**
 * #1795 — `tandem_search` with `regex: true` used to run the user's pattern on
 * the main thread, where one catastrophic `exec` froze the entire server.
 *
 * Teardown is hygiene, not a gate: under vitest's forks pool a leaked worker
 * does not hang the run (the pool kills the forked child), but it DOES hang a
 * bare `node` process — which is what the production server is. Every file that
 * calls `searchRegexInWorker` carries this hook for that reason.
 */
afterAll(() => shutdownSearchWorker());

/** Run `fn` while counting event-loop turns at 10 ms. */
async function withTicks<T>(fn: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
  }, 10);
  try {
    const value = await fn();
    return { value, ticks };
  } finally {
    clearInterval(interval);
  }
}

describe("searchRegexInWorker — the event loop stays free", () => {
  it("keeps ticking through an alternation blowup and reports a timeout", async () => {
    // `^(a|a)+$` is outside the `(x+)+` family, so nothing can short-circuit it
    // with a pattern sniff. `^` is load-bearing: exactly one blowup, at index 0.
    const t0 = Date.now();
    const { value, ticks } = await withTicks(() =>
      searchRegexInWorker("a".repeat(30) + "!", "^(a|a)+$"),
    );
    const elapsed = Date.now() - t0;

    expect(value.truncated).toBe("timeout");
    // No upper bound on `elapsed`: 2,033-2,304 ms has been measured on a loaded
    // box, so any ceiling near 2 s is noise, not a regression signal. The lower
    // bound proves the deadline fired; `ticks` proves the thread was free.
    expect(elapsed).toBeGreaterThan(1500);
    // Blocked measures ticks = 1 in every run (see the negative control below);
    // a free worker run measures 33-95. 10 sits an order of magnitude above the
    // blocked case and well below the lowest observed free value.
    expect(ticks).toBeGreaterThan(10);
  }, 15_000);

  it("negative control: the same class of exec ON the main thread blocks it", async () => {
    // This is the bug's own shape, reproduced deliberately and only in the test:
    // a synchronous main-thread `exec` of a catastrophic pattern. A fast literal
    // call would also score few ticks, which is why it is not the control.
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const re = new RegExp("(a+)+$", "gi");
    const t0 = Date.now();
    re.exec("a".repeat(26) + "b");
    const elapsed = Date.now() - t0;
    clearInterval(interval);

    expect(elapsed).toBeGreaterThan(500);
    expect(ticks).toBeLessThanOrEqual(2);
  }, 15_000);

  it("times out on the probe's own input", async () => {
    const t0 = Date.now();
    const result = await searchRegexInWorker("a".repeat(28) + "b", "(a+)+$");
    expect(result.truncated).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThan(1500);
  }, 15_000);
});

describe("searchRegexInWorker — partial results", () => {
  it("keeps the batches that arrived before a terminate, and loses the tail", async () => {
    // 300 cheap `x` matches, then one `exec` that spins for 20-35 s — far past
    // any deadline check, which only runs BETWEEN matches. So this is the hard
    // timer + terminate path by construction, and with batchSize 256 exactly
    // one batch was flushed: the 44 matches still in the worker's accumulator
    // are gone. That loss is the honest contract, and this pins it.
    const text = "x".repeat(300) + "a".repeat(28) + "!";
    const result = await searchRegexInWorker(text, "x|(a+)+$", { batchSize: 256 });

    expect(result.truncated).toBe("timeout");
    expect(result.matches).toHaveLength(256);
  }, 15_000);

  it("flushes the true partial set when matches are slow but interruptible", async () => {
    // Every `exec` pays a catastrophic failure over the a-run before the cheap
    // `Q` match, so the worker's loop DOES get between-match control and the
    // in-worker deadline fires cooperatively. `batchSize` above any achievable
    // count, so every returned match provably came from the deadline flush.
    const text = ("a".repeat(18) + "Q").repeat(20_000);
    const result = await searchRegexInWorker(text, "(a+)+z|Q", { batchSize: 1e9 });

    expect(result.truncated).toBe("timeout");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(20_000);
  }, 15_000);

  it("caps at maxMatches and keeps every match it collected", async () => {
    const result = await searchRegexInWorker("a".repeat(10_001), "a");
    expect(result.truncated).toBe("cap");
    expect(result.matches).toHaveLength(10_000);
    expect(result.error).toBeUndefined();
  }, 15_000);
});

describe("searchRegexInWorker — correctness", () => {
  it("advances past zero-length matches instead of hitting the cap", async () => {
    // Without the `lastIndex++` guard this spins to 10,000 matches in
    // milliseconds and reports a cap — a silent failure, since it looks fast.
    const result = await searchRegexInWorker("bbb", "a*");
    expect(result.matches).toBeDefined();
    expect(result.truncated).toBeUndefined();
  });

  it("returns matches for an ordinary regex", async () => {
    const result = await searchRegexInWorker("Hello 123 World 456", "\\d+");
    expect(result.matches.map((m) => m.text)).toEqual(["123", "456"]);
    expect(result.matches[0].from).toBe(6);
    expect(result.matches[0].to).toBe(9);
  });

  it("reports an invalid regex as an error string", async () => {
    const result = await searchRegexInWorker("Hello", "[invalid");
    expect(result.error).toMatch(/Invalid regex/);
    expect(result.matches).toHaveLength(0);
  });
});

describe("searchRegexInWorker — queueing", () => {
  it("respawns after a terminate and the NEXT request still runs off-thread", async () => {
    // An implementation that falls back to a synchronous main-thread search
    // after a terminate ("respawning lazily" later) passes every other
    // assertion here while reintroducing the bug on exactly the request that
    // follows each pathological one. Hence the tick assertion on the respawn.
    const spinning = searchRegexInWorker("a".repeat(28) + "b", "(a+)+$");
    const queued = searchRegexInWorker("cat and cat", "c.t");
    const [first, second] = await Promise.all([spinning, queued]);

    expect(first.truncated).toBe("timeout");
    expect(second.truncated).toBeUndefined();
    expect(second.matches.map((m) => m.text)).toEqual(["cat", "cat"]);

    const t0 = Date.now();
    const { value, ticks } = await withTicks(() =>
      searchRegexInWorker("a".repeat(30) + "!", "^(a|a)+$"),
    );
    expect(value.truncated).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThan(1500);
    expect(ticks).toBeGreaterThan(10);
  }, 15_000);

  it("runs four ordinary requests to completion", async () => {
    // Pins "the hard timer starts at DISPATCH, not at enqueue": a timer armed
    // on enqueue would time the fourth request out with zero matches, because
    // it waits behind three ~300-500 ms runs before its own window opens.
    const text = ("a".repeat(18) + "Q").repeat(60);
    const results = await Promise.all([
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
    ]);
    for (const result of results) {
      expect(result.truncated).toBeUndefined();
      expect(result.matches).toHaveLength(60);
    }
  }, 15_000);

  it("rejects a fifth concurrent request with a SEARCH_BUSY-tagged error", async () => {
    const text = ("a".repeat(18) + "Q").repeat(60);
    const inFlight = [
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
      searchRegexInWorker(text, "(a+)+z|Q"),
    ];
    const fifth = searchRegexInWorker(text, "(a+)+z|Q");

    await expect(fifth).rejects.toMatchObject({ code: "SEARCH_BUSY" });
    const settled = await Promise.all(inFlight);
    for (const result of settled) expect(result.matches).toHaveLength(60);
  }, 15_000);
});

describe("WORKER_SOURCE", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(WORKER_SOURCE)).not.toThrow();
  });

  it("is CommonJS-safe and free of template-literal syntax", () => {
    // An eval worker evaluates as CommonJS, so ESM syntax is a runtime syntax
    // error rather than a build error; the source is assembled from quoted
    // pieces, so a backtick or `${` would mean someone reached for a template.
    expect(WORKER_SOURCE).not.toContain("import ");
    expect(WORKER_SOURCE).not.toContain("`");
    expect(WORKER_SOURCE).not.toContain("${");
    expect(WORKER_SOURCE).toContain("require('node:worker_threads')");
  });

  it("carries no MCP tool-registration text", () => {
    // tests/docs/tool-count-drift.test.ts and
    // tests/server/license-gate-coverage.test.ts regex the concatenation of
    // every .ts file under src/server/mcp/, so a registration-shaped string in
    // this module's source would be counted as a real tool.
    for (const shape of [
      'server.tool("tandem_',
      'registerTool("tandem_',
      'gatedTool("tandem_',
      'withErrorBoundary("tandem_',
    ]) {
      expect(WORKER_SOURCE).not.toContain(shape);
    }
  });
});

describe("timeout defaults", () => {
  it("pins the two magnitudes the timing tests cannot see", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(1800);
    expect(DEFAULT_HARD_TIMEOUT_MS).toBe(2000);
  });
});
