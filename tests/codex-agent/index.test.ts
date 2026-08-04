/**
 * Coverage for the Codex worker entrypoint (`src/codex-agent/index.ts`).
 *
 * This module is ALL top-level code — there is no exported `main()` to call,
 * unlike the monitor/channel `index.ts` + `run.ts` split. It reads its env
 * vars, restores `{threadId, lastEventId}` from `TANDEM_CODEX_STATE_PATH`,
 * constructs a `CodexAppServerClient`, and starts `runEventConsumer` — all as
 * side effects of being imported, including a top-level `await`. So every
 * test here drives the module the same way: stub its four collaborators
 * (`atomicWriteConfigFile`, `runEventConsumer`, `CodexAppServerClient`,
 * `node:fs/promises#readFile`), `vi.resetModules()`, dynamic-`import()` the
 * module fresh, then invoke the callbacks it wired up as if the real
 * collaborators had called them.
 *
 * `runEventConsumer` and `client.initialize()` are both awaited at module
 * top level, so their mocks must resolve promptly or the dynamic import
 * never settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  atomicWriteConfigFileMock,
  runEventConsumerMock,
  CodexAppServerClientMock,
  clientInstances,
  readFileMock,
} = vi.hoisted(() => {
  const clientInstances: Array<{
    opts: Record<string, unknown>;
    initialize: ReturnType<typeof import("vitest").vi.fn>;
    enqueueEvent: ReturnType<typeof import("vitest").vi.fn>;
    stop: ReturnType<typeof import("vitest").vi.fn>;
  }> = [];
  return {
    atomicWriteConfigFileMock: vi.fn(async () => {}),
    runEventConsumerMock: vi.fn(async () => {}),
    readFileMock: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    clientInstances,
    // Regular (non-arrow) function so `new CodexAppServerClient(opts)` in the
    // module under test invokes this as a constructor; returning an object
    // from a constructor call makes `new` yield that object instead of
    // `this`, which is what lets us hand back a controllable fake instance.
    CodexAppServerClientMock: vi.fn(function (this: unknown, opts: Record<string, unknown>) {
      const instance = {
        opts,
        initialize: vi.fn(async () => {}),
        enqueueEvent: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      clientInstances.push(instance);
      return instance;
    }),
  };
});

vi.mock("../../src/server/integrations/storage.js", () => ({
  atomicWriteConfigFile: atomicWriteConfigFileMock,
}));

vi.mock("../../src/shared/sse-consumer.js", () => ({
  runEventConsumer: runEventConsumerMock,
}));

vi.mock("../../src/codex-agent/app-server-client.js", () => ({
  CodexAppServerClient: CodexAppServerClientMock,
}));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, default: actual, readFile: readFileMock };
});

const STATE_PATH = "C:/tmp/tandem-codex-state.json";

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

/** Fresh dynamic import of the module under test — re-runs its top-level side effects. */
async function importIndexModule(): Promise<void> {
  vi.resetModules();
  await import("../../src/codex-agent/index.js");
}

/** The options object the module passed to `runEventConsumer(...)`. */
function consumerOpts(): {
  tandemUrl: string;
  logPrefix: string;
  errorCode: string;
  onEvent: (event: unknown, eventId: string | undefined) => unknown;
  initialLastEventId?: string;
  onDeliveredEventId?: (eventId: string) => unknown;
} {
  const call = runEventConsumerMock.mock.calls.at(-1);
  if (!call) throw new Error("runEventConsumer was never called");
  return call[0] as ReturnType<typeof consumerOpts>;
}

/** The options object the module passed to `new CodexAppServerClient(...)`. */
function clientCtorOpts(): {
  cwd: string;
  initialThreadId?: string;
  onThreadId?: (threadId: string) => unknown;
  requestApproval?: (method: string, params: unknown) => Promise<unknown>;
} {
  const call = CodexAppServerClientMock.mock.calls.at(-1);
  if (!call) throw new Error("CodexAppServerClient was never constructed");
  return call[0] as ReturnType<typeof clientCtorOpts>;
}

beforeEach(() => {
  process.env.TANDEM_CODEX_CWD = "C:/repo";
  process.env.TANDEM_CODEX_WORKER_TOKEN = "test-worker-token";
  process.env.TANDEM_CODEX_STATE_PATH = STATE_PATH;
  process.env.TANDEM_URL = "http://127.0.0.1:9999";

  atomicWriteConfigFileMock.mockReset().mockResolvedValue(undefined);
  runEventConsumerMock.mockReset().mockImplementation(async () => {});
  readFileMock.mockReset().mockRejectedValue(enoent());
  CodexAppServerClientMock.mockClear();
  clientInstances.length = 0;
});

afterEach(() => {
  delete process.env.TANDEM_CODEX_CWD;
  delete process.env.TANDEM_CODEX_WORKER_TOKEN;
  delete process.env.TANDEM_CODEX_STATE_PATH;
  delete process.env.TANDEM_URL;
  // The module registers process.once("SIGINT"/"SIGTERM", ...) on every
  // import; without this, ten reimports across this file would trip Node's
  // MaxListenersExceededWarning.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  vi.unstubAllGlobals();
});

describe("SSE event consumer wiring", () => {
  it("starts runEventConsumer with the resolved URL, a Codex log prefix, and MONITOR_CONNECT_FAILED", async () => {
    const { MONITOR_CONNECT_FAILED } = await import("../../src/shared/types.js");
    await importIndexModule();

    expect(runEventConsumerMock).toHaveBeenCalledTimes(1);
    const opts = consumerOpts();
    expect(opts.tandemUrl).toBe("http://127.0.0.1:9999");
    expect(opts.logPrefix).toBe("[Codex agent]");
    expect(opts.errorCode).toBe(MONITOR_CONNECT_FAILED);
  });

  it("wires onEvent to the client's enqueueEvent, forwarding the event and eventId unchanged", async () => {
    await importIndexModule();
    const opts = consumerOpts();
    const [client] = clientInstances;
    const sampleEvent = {
      id: "evt_1",
      type: "chat:message",
      timestamp: 123,
      payload: { messageId: "m1", text: "hi", replyTo: null, anchor: null },
    };

    await opts.onEvent(sampleEvent, "evt_1");

    expect(client.enqueueEvent).toHaveBeenCalledExactlyOnceWith(sampleEvent, "evt_1");
  });

  it("forwards onEvent even with eventId undefined (positive control: the callback doesn't require one)", async () => {
    await importIndexModule();
    const opts = consumerOpts();
    const [client] = clientInstances;
    const sampleEvent = {
      id: "evt_2",
      type: "chat:message",
      timestamp: 456,
      payload: { messageId: "m2", text: "hi again", replyTo: null, anchor: null },
    };

    await opts.onEvent(sampleEvent, undefined);

    expect(client.enqueueEvent).toHaveBeenCalledExactlyOnceWith(sampleEvent, undefined);
  });
});

describe("{threadId, lastEventId} state restoration", () => {
  it("restores both fields from a well-formed state file", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ threadId: "thread-restored", lastEventId: "evt-restored" }),
    );

    await importIndexModule();

    expect(clientCtorOpts().initialThreadId).toBe("thread-restored");
    expect(consumerOpts().initialLastEventId).toBe("evt-restored");
  });

  it("positive control: with no state file (ENOENT), both fields are absent — proves restoration is genuinely conditional on the file", async () => {
    readFileMock.mockRejectedValue(enoent());

    await importIndexModule();

    expect(clientCtorOpts().initialThreadId).toBeUndefined();
    expect(consumerOpts().initialLastEventId).toBeUndefined();
  });

  it("ignores malformed JSON and starts fresh instead of throwing", async () => {
    readFileMock.mockResolvedValue("{not valid json");

    await expect(importIndexModule()).resolves.toBeUndefined();

    expect(clientCtorOpts().initialThreadId).toBeUndefined();
    expect(consumerOpts().initialLastEventId).toBeUndefined();
  });

  it("ignores a state file over the 16 KiB cap and starts fresh", async () => {
    const oversized = JSON.stringify({
      threadId: "t",
      lastEventId: "e",
      padding: "x".repeat(20_000),
    });
    expect(oversized.length).toBeGreaterThan(16_384);
    readFileMock.mockResolvedValue(oversized);

    await importIndexModule();

    expect(clientCtorOpts().initialThreadId).toBeUndefined();
    expect(consumerOpts().initialLastEventId).toBeUndefined();
  });

  it("ignores non-string threadId/lastEventId fields rather than passing them through", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ threadId: 42, lastEventId: null }));

    await importIndexModule();

    expect(clientCtorOpts().initialThreadId).toBeUndefined();
    expect(consumerOpts().initialLastEventId).toBeUndefined();
  });
});

describe("{threadId, lastEventId} state persistence to TANDEM_CODEX_STATE_PATH", () => {
  it("persists a new threadId via onThreadId, awaited, to the configured state path", async () => {
    await importIndexModule();
    const { onThreadId } = clientCtorOpts();
    if (!onThreadId) throw new Error("onThreadId was not wired");

    await onThreadId("thread-new");

    expect(atomicWriteConfigFileMock).toHaveBeenCalledTimes(1);
    const [path, content] = atomicWriteConfigFileMock.mock.calls[0] as [string, string];
    expect(path).toBe(STATE_PATH);
    expect(JSON.parse(content)).toEqual({ threadId: "thread-new" });
    // Trailing newline, matching every other atomic-write config file in the codebase.
    expect(content.endsWith("\n")).toBe(true);
  });

  it("persists a delivered eventId via onDeliveredEventId (fire-and-forget from the caller's side)", async () => {
    await importIndexModule();
    const { onDeliveredEventId } = consumerOpts();
    if (!onDeliveredEventId) throw new Error("onDeliveredEventId was not wired");

    // Production deliberately does not await this call (see the source
    // comment on `onDeliveredEventId` in index.ts) — so neither do we here;
    // the write still has to land asynchronously.
    onDeliveredEventId("evt-delivered");

    await vi.waitFor(() => expect(atomicWriteConfigFileMock).toHaveBeenCalledTimes(1));
    const [path, content] = atomicWriteConfigFileMock.mock.calls[0] as [string, string];
    expect(path).toBe(STATE_PATH);
    expect(JSON.parse(content)).toEqual({ lastEventId: "evt-delivered" });
  });

  it("merges threadId and lastEventId into one persisted snapshot rather than overwriting each other", async () => {
    await importIndexModule();
    const { onThreadId } = clientCtorOpts();
    const { onDeliveredEventId } = consumerOpts();
    if (!onThreadId || !onDeliveredEventId) throw new Error("callbacks not wired");

    await onThreadId("thread-merge");
    onDeliveredEventId("evt-merge");

    await vi.waitFor(() => expect(atomicWriteConfigFileMock).toHaveBeenCalledTimes(2));
    const lastCall = atomicWriteConfigFileMock.mock.calls.at(-1) as [string, string];
    expect(JSON.parse(lastCall[1])).toEqual({ threadId: "thread-merge", lastEventId: "evt-merge" });
  });
});

describe("promise-chain sequencing of the state writer", () => {
  it("a failed write does not permanently latch the writer — the NEXT update still persists", async () => {
    await importIndexModule();
    const { onDeliveredEventId } = consumerOpts();
    if (!onDeliveredEventId) throw new Error("onDeliveredEventId was not wired");

    // First write fails (disk full, permissions, whatever). The base
    // implementation set in beforeEach (resolve) takes over for every call
    // after this one-time override.
    atomicWriteConfigFileMock.mockRejectedValueOnce(new Error("disk full"));

    onDeliveredEventId("evt-a");
    // Real-timer wait rather than vi.waitFor: this needs the FIRST write's
    // rejection to be caught and `flushing` reset to null (a chain of
    // several microtask turns) before evt-b's call is dispatched, mirroring
    // the mutex-acquisition waits used elsewhere in the test suite (e.g.
    // tests/server/integrations/api-routes.test.ts's concurrency describe).
    await new Promise((r) => setTimeout(r, 50));

    // This is the specific defect class called out for this file: an
    // unguarded `chain = chain.then(fn)` serializer latches permanently
    // rejected after ONE failure, and every later `onDeliveredEventId` call
    // would silently stop writing anything for the rest of the worker's
    // life. If that regresses, this second write never happens and the
    // assertion below sees only one call.
    onDeliveredEventId("evt-b");
    await new Promise((r) => setTimeout(r, 50));

    expect(atomicWriteConfigFileMock).toHaveBeenCalledTimes(2);
    const secondCall = atomicWriteConfigFileMock.mock.calls[1] as [string, string];
    expect(JSON.parse(secondCall[1])).toEqual({ lastEventId: "evt-b" });
  });

  it("positive control: with no failure, both writes still land in order (isolates the recovery behavior above from ordinary coalescing)", async () => {
    await importIndexModule();
    const { onDeliveredEventId } = consumerOpts();
    if (!onDeliveredEventId) throw new Error("onDeliveredEventId was not wired");

    onDeliveredEventId("evt-x");
    await new Promise((r) => setTimeout(r, 50));
    onDeliveredEventId("evt-y");
    await new Promise((r) => setTimeout(r, 50));

    expect(atomicWriteConfigFileMock).toHaveBeenCalledTimes(2);
    const calls = atomicWriteConfigFileMock.mock.calls as Array<[string, string]>;
    expect(JSON.parse(calls[0][1])).toEqual({ lastEventId: "evt-x" });
    expect(JSON.parse(calls[1][1])).toEqual({ lastEventId: "evt-y" });
  });
});

describe("requiredEnv guard", () => {
  it("throws (and the import rejects) when a required env var is missing", async () => {
    delete process.env.TANDEM_CODEX_STATE_PATH;

    await expect(importIndexModule()).rejects.toThrow(/TANDEM_CODEX_STATE_PATH is required/);
  });
});

describe("approval bridge (requestApproval)", () => {
  it("POSTs to the approval-request endpoint with the worker token header and returns the parsed result", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { decision: "accept" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await importIndexModule();
    const { requestApproval } = clientCtorOpts();
    if (!requestApproval) throw new Error("requestApproval was not wired");

    const result = await requestApproval("item/commandExecution/requestApproval", {
      command: "ls",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:9999/api/codex/approval-request");
    expect((init.headers as Record<string, string>)["x-tandem-codex-worker-token"]).toBe(
      "test-worker-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      method: "item/commandExecution/requestApproval",
      params: { command: "ls" },
    });
  });

  it("falls back to decline when the broker responds without a result field", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await importIndexModule();
    const { requestApproval } = clientCtorOpts();
    if (!requestApproval) throw new Error("requestApproval was not wired");

    await expect(
      requestApproval("item/commandExecution/requestApproval", { command: "ls" }),
    ).resolves.toEqual({ decision: "decline" });
  });

  it("throws when the broker HTTP call itself fails, rather than silently declining", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await importIndexModule();
    const { requestApproval } = clientCtorOpts();
    if (!requestApproval) throw new Error("requestApproval was not wired");

    await expect(
      requestApproval("item/commandExecution/requestApproval", { command: "ls" }),
    ).rejects.toThrow(/503/);
  });
});
