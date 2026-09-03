/**
 * Off-main-thread regex search for `tandem_search` (#1795).
 *
 * The literal search path stays on the main thread — `escapeRegex`'d patterns
 * cannot backtrack catastrophically. Only `regex: true` comes here, because a
 * user-supplied pattern can. `(a+)+$` against 28 a's followed by a `b` spun the
 * main thread for ~40 s on the reference box (Node v24.14.1), during which every
 * MCP request, Hocuspocus sync, autosave and wake-stream event stalled.
 *
 * Design notes that are easy to get wrong:
 *
 *  - **The main thread never compiles or `exec`s the user's pattern.** Not even
 *    a "cheap" `try { new RegExp(q) } catch` pre-check: V8 compiles regexes
 *    lazily, so the cost of a pathological pattern lands on the first `exec`,
 *    not on `new RegExp`, and a pre-check would block for exactly as long as
 *    the thing it was meant to avoid. An invalid regex is classified only from
 *    the worker's `error` field.
 *
 *  - **The worker is built from an eval string, not a file URL.** The server
 *    ships as a single ESM bundle with `splitting: false` (`tsup.config.ts`),
 *    so there is no separate worker file on disk to point a URL at. An eval
 *    worker evaluates as CommonJS, which is why `WORKER_SOURCE` uses `require`
 *    and contains no ESM syntax.
 *
 *  - **`stdout: true, stderr: true` reads inverted**: it means "do NOT
 *    auto-pipe the worker's stdio into the parent's". That is what keeps the
 *    worker off the MCP wire — Critical Rule 3's `console.log` -> stderr
 *    redirect in `src/server/index.ts` is main-thread only, so a worker writing
 *    to the real fd 1 would corrupt stdio-mode framing. We drain both streams
 *    into `process.stderr` ourselves.
 *
 *  - **Two timeouts, and they mean different things.** The worker checks the
 *    clock between matches (`deadlineMs`, 1800 ms) and returns the true partial
 *    set for a regex that is merely slow per match — the cooperative path. The
 *    main thread's hard timer (`hardTimeoutMs`, 2000 ms, started at DISPATCH,
 *    not at enqueue) plus `worker.terminate()` is the backstop for a single
 *    un-interruptible `exec`. On that path **the worker's un-posted accumulator
 *    tail is lost by construction** — we resolve with the batches that already
 *    arrived. That is the honest contract; callers get `truncated: "timeout"`.
 *
 *  - **Queue latency is not bounded by those timers.** With the queue full, the
 *    fourth request can wait roughly 6 s for its turn before its own 2 s window
 *    even opens. MCP clients carry their own tool timeouts; that is the bound.
 */

import { Worker } from "node:worker_threads";
import { toFlatOffset } from "../../shared/positions/types.js";
import type { SearchMatch } from "./navigation.js";

export interface WorkerSearchResult {
  matches: SearchMatch[];
  truncated?: "cap" | "timeout";
  error?: string;
}

export interface SearchWorkerOptions {
  maxMatches?: number;
  deadlineMs?: number;
  hardTimeoutMs?: number;
  batchSize?: number;
}

/** In-worker cooperative deadline: yields the TRUE partial set. */
export const DEFAULT_DEADLINE_MS = 1800;
/** Main-thread backstop for a single `exec` the deadline check never reaches. */
export const DEFAULT_HARD_TIMEOUT_MS = 2000;
export const DEFAULT_MAX_MATCHES = 10_000;
export const DEFAULT_BATCH_SIZE = 256;
/** One in flight plus three waiting. */
export const MAX_QUEUE = 4;

/**
 * The worker body, as a string.
 *
 * Assembled from quoted pieces rather than a template literal on purpose: the
 * worker's own code uses string concatenation, and a template literal here
 * would need every inner backtick and `$`-brace escaped. No ESM syntax — an
 * eval worker is CommonJS.
 *
 * Flush rule: AFTER pushing a match, if the accumulator has reached
 * `batchSize`, post it and reset.
 *
 * The terminate test pins 256 delivered matches out of 300 with
 * `batchSize: 256`, and it is worth being exact about what that pins, because
 * the obvious reading is wrong. It discriminates flush-ON-OVERFLOW (`>`, which
 * delivers 257) — it does NOT discriminate check-before-push. At 300 matches
 * check-before-push flushes the same 256, just one iteration later, immediately
 * before pushing #257; the two rules differ only in what sits in the `done`
 * message's tail, and the terminate path discards that tail by construction. So
 * do not add a test chasing that distinction: it is unobservable here, and this
 * comment exists so the next reader does not re-derive a discrimination the
 * test cannot make.
 */
export const WORKER_SOURCE = [
  "'use strict';",
  "const wt = require('node:worker_threads');",
  "const port = wt.parentPort;",
  "port.on('message', function (msg) {",
  "  const id = msg.id;",
  "  let re;",
  "  try {",
  "    re = new RegExp(msg.query, 'gi');",
  "  } catch (err) {",
  "    const detail = err && err.message ? err.message : String(err);",
  "    port.postMessage({ id: id, done: true, error: 'Invalid regex: ' + detail });",
  "    return;",
  "  }",
  "  const text = msg.text;",
  "  const started = Date.now();",
  "  let acc = [];",
  "  let total = 0;",
  "  let m;",
  "  while ((m = re.exec(text)) !== null) {",
  "    acc.push({ from: m.index, to: m.index + m[0].length, text: m[0] });",
  "    total++;",
  "    if (acc.length >= msg.batchSize) {",
  "      port.postMessage({ id: id, batch: acc });",
  "      acc = [];",
  "    }",
  "    if (total >= msg.maxMatches) {",
  "      port.postMessage({ id: id, done: true, batch: acc, truncated: 'cap' });",
  "      return;",
  "    }",
  "    if (Date.now() - started > msg.deadlineMs) {",
  "      port.postMessage({ id: id, done: true, batch: acc, truncated: 'timeout' });",
  "      return;",
  "    }",
  "    if (m[0].length === 0) re.lastIndex++;",
  "  }",
  "  port.postMessage({ id: id, done: true, batch: acc });",
  "});",
].join("\n");

interface RawMatch {
  from: number;
  to: number;
  text: string;
}

interface WorkerMessage {
  id: number;
  batch?: RawMatch[];
  done?: boolean;
  truncated?: "cap" | "timeout";
  error?: string;
}

interface Job {
  id: number;
  message: {
    id: number;
    text: string;
    query: string;
    maxMatches: number;
    batchSize: number;
    deadlineMs: number;
  };
  hardTimeoutMs: number;
  resolve: (result: WorkerSearchResult) => void;
  reject: (err: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 1;
let queue: Job[] = [];
let inFlight: { job: Job; matches: RawMatch[]; timer: NodeJS.Timeout } | null = null;

function searchBusyError(): Error {
  return Object.assign(new Error("Too many concurrent regex searches are queued. Retry."), {
    code: "SEARCH_BUSY",
  });
}

function toMatches(raw: RawMatch[]): SearchMatch[] {
  return raw.map((r) => ({ from: toFlatOffset(r.from), to: toFlatOffset(r.to), text: r.text }));
}

/**
 * Construct the worker and attach every listener SYNCHRONOUSLY, in this tick,
 * before any `await` and before the first `postMessage`. An unlistened Worker
 * `error` throws in the parent, which becomes an `uncaughtException` and takes
 * the server down through `handleFatalError`.
 */
function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true, stdout: true, stderr: true });
  worker = w;
  w.on("error", (err: unknown) => {
    handleWorkerDeath(w, err instanceof Error ? err : new Error(String(err)));
  });
  w.on("exit", () => handleWorkerDeath(w, new Error("Search worker exited unexpectedly")));
  w.on("message", (msg: WorkerMessage) => {
    if (w === worker) handleMessage(msg);
  });
  w.stdout.pipe(process.stderr);
  w.stderr.pipe(process.stderr);
  return w;
}

/**
 * A worker we did not deliberately replace has died. Fail the in-flight job and
 * respawn lazily on the next request; queued jobs were never dispatched, so
 * they simply run against the new worker.
 */
function handleWorkerDeath(w: Worker, err: Error): void {
  if (w !== worker) return;
  worker = null;
  const current = inFlight;
  inFlight = null;
  if (current) {
    clearTimeout(current.timer);
    current.job.reject(err);
  }
  pump();
}

function handleMessage(msg: WorkerMessage): void {
  const current = inFlight;
  if (!current || msg.id !== current.job.id) return;
  if (msg.batch) current.matches.push(...msg.batch);
  if (!msg.done) return;
  clearTimeout(current.timer);
  inFlight = null;
  current.job.resolve({
    // An invalid pattern never produced a match, so the worker sends `error`
    // with no batches; there is nothing to keep alongside it.
    matches: msg.error ? [] : toMatches(current.matches),
    ...(msg.truncated ? { truncated: msg.truncated } : {}),
    ...(msg.error ? { error: msg.error } : {}),
  });
  pump();
}

function onHardTimeout(): void {
  const current = inFlight;
  if (!current) return;
  inFlight = null;
  const w = worker;
  worker = null;
  const finish = () => {
    // The accumulator tail still inside the terminated worker is gone. We
    // resolve with the batches that made it across, which is the honest
    // partial set, and label it a timeout.
    current.job.resolve({ matches: toMatches(current.matches), truncated: "timeout" });
    pump();
  };
  if (!w) {
    finish();
    return;
  }
  // Awaited, never fire-and-forget: a terminated worker leaves a live
  // MessagePort handle that keeps a bare Node process alive indefinitely unless
  // the terminate promise settles (measured: fire-and-forget leaves
  // `handles=[MessagePort,MessagePort]` alive at 18 s; awaited exits in 0 ms).
  //
  // NOTHING IN THE SUITE PINS THIS, deliberately. The leak only manifests in a
  // bare `node` process — which is exactly what the production server is — and
  // vitest's forks pool masks it by killing the forked child, so a file that
  // leaks a worker still exits 0 with no delay. A gate whose criterion this
  // runner cannot evaluate reports success when it could not evaluate, which is
  // the failure mode ADR-051 exists to avoid. The missing coverage is stated
  // here rather than papered over with a test that would pass either way.
  w.terminate().then(finish, finish);
}

function pump(): void {
  if (inFlight) return;
  const job = queue.shift();
  if (!job) return;
  const w = ensureWorker();
  const timer = setTimeout(onHardTimeout, job.hardTimeoutMs);
  timer.unref();
  inFlight = { job, matches: [], timer };
  w.postMessage(job.message);
}

/**
 * Run `query` as a regex over `text` on a worker thread.
 *
 * Rejects with a `code: "SEARCH_BUSY"` tagged Error when the queue is full —
 * before enqueuing, so the queue stays at `MAX_QUEUE`. The module cannot return
 * an MCP error envelope under its declared type, so the handler maps it.
 */
export function searchRegexInWorker(
  text: string,
  query: string,
  opts: SearchWorkerOptions = {},
): Promise<WorkerSearchResult> {
  if (queue.length + (inFlight ? 1 : 0) >= MAX_QUEUE) {
    return Promise.reject(searchBusyError());
  }
  const id = nextId++;
  return new Promise<WorkerSearchResult>((resolve, reject) => {
    queue.push({
      id,
      message: {
        id,
        text,
        query,
        maxMatches: opts.maxMatches ?? DEFAULT_MAX_MATCHES,
        batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
        deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
      },
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS,
      resolve,
      reject,
    });
    pump();
  });
}

/**
 * Terminate the worker and fail anything outstanding. Resolves when the
 * terminate settles — a `.then()` in an `afterAll` hook needs a real promise,
 * so the no-worker case returns `Promise.resolve()` rather than `undefined`.
 */
export function shutdownSearchWorker(): Promise<void> {
  const w = worker;
  worker = null;
  const outstanding: Job[] = [];
  if (inFlight) {
    clearTimeout(inFlight.timer);
    outstanding.push(inFlight.job);
    inFlight = null;
  }
  outstanding.push(...queue);
  queue = [];
  for (const job of outstanding) job.reject(searchBusyError());
  if (!w) return Promise.resolve();
  return w.terminate().then(
    () => undefined,
    () => undefined,
  );
}
