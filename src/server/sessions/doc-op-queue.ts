/**
 * The per-document operation queue (#2358, ADR-054; ownership design §5.1).
 *
 * **Flag-on only.** With ownership on, every MCP write tool's operation on a
 * document and every `tandem_open` take runs at its turn in that document's
 * queue, so an ownership check and the write it guards cannot be separated by
 * another session's operation. A lapse runs at its turn too, unless its wait
 * runs out first (below). With ownership off nothing calls
 * this module: handlers run their bodies directly, as they always have.
 *
 * **Not every ownership change is queued.** Four run where they are, not at a
 * turn of their own: a lapse whose wait for its turn ran out
 * ({@link runWhenDocIdle}: beside the operation still running when its timer
 * fires first, or between two operations when its late turn comes first), and
 * three that are synchronous by design: the tab-close point (`onDocumentClosed`), the user-open default
 * (`applyUserOpenDefault`: `/api/open`, upload, scratchpad, `/api/convert`,
 * startup; it only
 * writes an entry where there is none, and writes nothing until Tandem's
 * Claude can be present, so PR 3b must queue it), and the backstop that
 * clears an entry whose record no longer exists (`liveEntry`, which every
 * decision runs first).
 *
 * **A leaf.** It imports nothing from the project.
 *
 * **Each operation is chained with `.then` from its own call.** A promise
 * callback runs in the async context of the code that attached it, so an
 * operation sees its own request context (`wakeUrlField()` reads
 * `peerIsLoopback` from it) however long it waited and whoever ran before it.
 * A shared drain loop would run every body in the first caller's context.
 *
 * **The chain is keyed by document id and survives a close and reopen.** The
 * id is a hash of the path, so a reopened document is the same key, and an
 * operation still running when its tab closed keeps later operations on the
 * reopened document behind it. Dropping the chain at close would let that
 * operation's write land beside a new holder's.
 *
 * **The wait is bounded; the operation is not** (Bryan, 2026-11-11). An
 * operation that finds the document busy waits at most {@link DOC_OP_WAIT_MS}
 * for its turn. Past that its caller is refused ({@link DocOpWaitExpired}),
 * it stops counting as queued, and when its turn does come it is skipped, so
 * the order behind it holds. An operation whose caller's request was aborted
 * by the time its turn comes is skipped the same way ({@link DocOpCancelled}).
 * An operation that has started is never cancelled: if it never settles (a
 * save stalled on a dead mount), every later operation on that document is
 * refused after the limit, and the chain stays occupied until the server
 * restarts. Each refused call's turn callback stays chained until then, and
 * it keeps that call's body and arguments alive with it.
 *
 * **The turn callback is attached from the entrant's own call**, timer or no
 * timer: the timer only marks the entrant as gone and rejects its promise.
 */

/**
 * How long an operation waits for its turn before its caller is told the
 * document is busy. Below the stdio bridge's own 30 s request timeout
 * (`STDIO_BRIDGE_REQUEST_TIMEOUT_MS` in `shared/constants.ts`, used by `src/cli/mcp-stdio.ts`), which gives up without telling the server: a
 * waiting call is refused here first, and can never start later than this
 * after it was queued. `tests/server/doc-op-queue.test.ts` pins the relation.
 */
export const DOC_OP_WAIT_MS = 20_000;

let waitMs = DOC_OP_WAIT_MS;

/** The caller's wait for its turn ran out and it was not run. */
export class DocOpWaitExpired extends Error {
  /** The limit that applied to this wait (not a measurement of the time spent). */
  readonly waitedMs: number;
  constructor(waitedMs: number) {
    super("the document's operation queue was busy for longer than the wait limit");
    this.name = "DocOpWaitExpired";
    this.waitedMs = waitedMs;
  }
}

/** The caller's request was aborted before its turn came; it was not run. */
export class DocOpCancelled extends Error {
  constructor() {
    super("the request was cancelled before its turn in the document's operation queue");
    this.name = "DocOpCancelled";
  }
}

export interface DocOpOptions {
  /** The caller's request signal. Read once, when the operation's turn comes. */
  signal?: AbortSignal;
  /** A shorter wait than the limit: what is left of a deadline shared by several operations. */
  waitMs?: number;
}

interface Chain {
  tail: Promise<void>;
  pending: number;
}

const chains = new Map<string, Chain>();

const timers = new Set<ReturnType<typeof setTimeout>>();

/**
 * Run `fn` after every operation already queued for `documentId` has settled,
 * or reject with {@link DocOpWaitExpired} / {@link DocOpCancelled} without
 * running it. A rejected or throwing operation does not break the chain: its
 * failure goes to its own caller and the next operation runs.
 */
export function runDocOp<T>(
  documentId: string,
  fn: () => Promise<T> | T,
  options: DocOpOptions = {},
): Promise<T> {
  const existing = chains.get(documentId);
  const mine = existing ?? { tail: Promise.resolve(), pending: 0 };
  if (!existing) chains.set(documentId, mine);
  mine.pending++;
  // The tail is replaced BEFORE `fn` can run, with a gate that opens when this
  // operation settles: an operation queued from inside `fn` (a lapse triggered
  // when a write's claim is applied at its outcome, say) then waits for this
  // one, behind whatever was queued meanwhile, instead of chaining onto the
  // old, already-resolved tail.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const previous = mine.tail;
  mine.tail = gate;

  if (!existing) {
    // An idle document starts its operation in this very tick, as a handler
    // with no queue would: the synchronous head of the body (and so the
    // ownership check and claim) runs before the caller's next line.
    const result = startNow(fn);
    const done = () => {
      settle(documentId, mine);
      open();
    };
    result.then(done, done);
    return result;
  }

  return new Promise<T>((resolve, reject) => {
    // Exactly one of three things ends the wait, decided on this one flag in
    // synchronous code: the turn comes, the turn comes for an aborted
    // request, or the timer fires first.
    let waiting = true;
    const limit = Math.max(0, options.waitMs ?? waitMs);
    const queuedAt = Date.now();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!waiting) return;
      waiting = false;
      // Gone from the count now; the gate still opens only at its turn, so
      // whatever is behind it cannot start beside the operation ahead.
      settle(documentId, mine);
      reject(new DocOpWaitExpired(limit));
    }, limit);
    timer.unref?.();
    timers.add(timer);

    // Attached here, from the entrant's own call, so `fn` runs in the
    // entrant's async context whoever ran before it.
    previous.then(() => {
      if (!waiting) {
        open();
        return;
      }
      waiting = false;
      clearTimeout(timer);
      timers.delete(timer);
      // The turn is a promise callback and the expiry a timer: after a long
      // synchronous stretch the turn can come first although the limit has
      // passed. The clock decides, so an operation never starts later than
      // the limit after it was queued.
      const late = Date.now() - queuedAt >= limit;
      if (late || options.signal?.aborted) {
        settle(documentId, mine);
        // Reject BEFORE opening the gate: the caller's handler is then queued
        // ahead of the next entrant's turn. A lapse runs out of turn from that
        // handler, and must move the document before the next entrant's
        // ownership check reads who holds it. That holds for a handler
        // attached DIRECTLY to the promise this function returned, one hop,
        // as `runWhenDocIdle` does: wrap the promise first and the next
        // entrant's turn comes before the handler again.
        reject(late ? new DocOpWaitExpired(limit) : new DocOpCancelled());
        open();
        return;
      }
      const done = () => {
        settle(documentId, mine);
        open();
      };
      const result = startNow(fn);
      result.then(done, done);
      result.then(resolve, reject);
    });
  });
}

function startNow<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function settle(documentId: string, chain: Chain): void {
  chain.pending--;
  if (chain.pending === 0 && chains.get(documentId) === chain) chains.delete(documentId);
}

/** Whether any operation is queued or running for `documentId`. */
export function isDocOpQueueBusy(documentId: string): boolean {
  return chains.has(documentId);
}

/**
 * Run `fn` now if `documentId`'s queue is idle, otherwise at its turn. For
 * ownership changes that are not tool calls (a lapse): synchronous when
 * nothing is in flight, and never in the middle of another record's operation
 * — **unless its wait runs out**. Then `fn` runs right there, out of turn,
 * once: a document must not stay with a dead owner because one operation
 * never settled. Its clock starts when it is queued, so it can then land
 * beside an operation that has only just started. `fn` must therefore read
 * the state it acts on when it runs, as the lapse step does.
 * A throw from a deferred `fn` is reported to `onError` and goes nowhere else.
 */
export function runWhenDocIdle(
  documentId: string,
  fn: () => void,
  onError: (err: unknown) => void,
): void {
  if (!chains.has(documentId)) {
    fn();
    return;
  }
  runDocOp(documentId, fn).catch((err: unknown) => {
    if (!(err instanceof DocOpWaitExpired)) {
      onError(err);
      return;
    }
    try {
      fn();
    } catch (late) {
      onError(late);
    }
  });
}

/** How many waits for a turn have a timer running. */
export function docOpWaitTimersForTests(): number {
  return timers.size;
}

/** How many documents have a live chain. For "nothing was created" assertions. */
export function docOpQueueSizeForTests(): number {
  return chains.size;
}

/** Set the wait limit, or restore the default with no argument. */
export function setDocOpWaitMsForTests(ms: number = DOC_OP_WAIT_MS): void {
  waitMs = ms;
}

/** Forget every chain and wait timer, and restore the limit. Operations already chained still run. */
export function resetDocOpQueuesForTests(): void {
  chains.clear();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  waitMs = DOC_OP_WAIT_MS;
}
