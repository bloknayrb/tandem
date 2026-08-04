import { atomicWriteConfigFile } from "../server/integrations/storage.js";
import { API_CODEX_APPROVAL_REQUEST } from "../shared/api-paths.js";
import { resolveTandemUrl } from "../shared/cli-runtime.js";
import { runEventConsumer } from "../shared/sse-consumer.js";
import { MONITOR_CONNECT_FAILED } from "../shared/types.js";
import { CodexAppServerClient } from "./app-server-client.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const cwd = requiredEnv("TANDEM_CODEX_CWD");
const workerToken = requiredEnv("TANDEM_CODEX_WORKER_TOKEN");
const statePath = requiredEnv("TANDEM_CODEX_STATE_PATH");

interface WorkerState {
  threadId?: string;
  lastEventId?: string;
}

let workerState: WorkerState = {};
try {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(statePath, "utf8");
  if (raw.length <= 16_384) {
    const parsed = JSON.parse(raw) as WorkerState;
    workerState = {
      ...(typeof parsed.threadId === "string" ? { threadId: parsed.threadId } : {}),
      ...(typeof parsed.lastEventId === "string" ? { lastEventId: parsed.lastEventId } : {}),
    };
  }
} catch {
  // First launch or malformed state starts a fresh thread/cursor.
}

let flushing: Promise<void> | null = null;
let dirty = false;

/**
 * Record a state patch and persist it.
 *
 * Coalescing, latest-wins: the file is a snapshot, not a log, so every patch
 * that lands while a write is in flight collapses into one follow-up write.
 * The previous `chain = chain.then(...)` form had two problems — it queued a
 * whole temp-file-and-rename per patch, and a single rejected write latched the
 * chain forever, after which `.then(fn)` never ran `fn` again and no state was
 * ever written for the life of the worker, silently.
 */
function updateWorkerState(patch: Partial<WorkerState>): Promise<void> {
  workerState = { ...workerState, ...patch };
  dirty = true;
  if (!flushing) {
    flushing = flushWorkerState().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function flushWorkerState(): Promise<void> {
  while (dirty) {
    dirty = false;
    try {
      await atomicWriteConfigFile(statePath, `${JSON.stringify(workerState, null, 2)}\n`);
    } catch (err) {
      // A lost cursor costs a replay, not correctness — so this is logged and
      // dropped rather than rethrown, which would latch the writer again.
      console.error(
        `[Codex agent] could not persist worker state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const tandemUrl = resolveTandemUrl();

const client = new CodexAppServerClient({
  cwd,
  initialThreadId: workerState.threadId,
  onThreadId: (threadId) => updateWorkerState({ threadId }),
  requestApproval: async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 125_000);
    try {
      const response = await fetch(new URL(API_CODEX_APPROVAL_REQUEST, tandemUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tandem-codex-worker-token": workerToken,
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`approval broker returned HTTP ${response.status}`);
      const body = (await response.json()) as { result?: unknown };
      return body.result ?? { decision: "decline" };
    } finally {
      clearTimeout(timer);
    }
  },
  onFatal: (error) => {
    console.error(`[Codex agent] ${error.message}`);
    process.exit(1);
  },
});
await client.initialize();

const stop = () => void client.stop().finally(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await runEventConsumer({
  tandemUrl,
  logPrefix: "[Codex agent]",
  errorCode: MONITOR_CONNECT_FAILED,
  onEvent: (event, eventId) => client.enqueueEvent(event, eventId),
  initialLastEventId: workerState.lastEventId,
  // Deliberately not awaited. `runEventConsumer` awaits this hook before
  // advancing its in-memory cursor, so awaiting the disk write here puts a
  // temp-file-and-rename on the critical path of every single event. The
  // on-disk cursor can only ever trail the in-memory one, and trailing means
  // the worker replays a handful of events after a crash — the safe direction.
  // `onThreadId` above IS awaited: losing that id costs the conversation.
  onDeliveredEventId: (lastEventId) => void updateWorkerState({ lastEventId }),
});
