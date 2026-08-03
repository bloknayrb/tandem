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

let stateWrite = Promise.resolve();
function updateWorkerState(patch: Partial<WorkerState>): Promise<void> {
  workerState = { ...workerState, ...patch };
  const snapshot = JSON.stringify(workerState, null, 2) + "\n";
  stateWrite = stateWrite.then(() => atomicWriteConfigFile(statePath, snapshot));
  return stateWrite;
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
  onDeliveredEventId: (lastEventId) => updateWorkerState({ lastEventId }),
});
