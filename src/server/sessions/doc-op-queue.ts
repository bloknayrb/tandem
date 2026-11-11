/**
 * The per-document operation queue (#2358, ADR-054; ownership design §5.1).
 *
 * **Flag-on only.** With ownership on, every MCP write tool's operation on a
 * document, every `tandem_open` take and every lapse runs at its turn in that
 * document's queue, so an ownership check and the write it guards cannot be
 * separated by another session's operation. With ownership off nothing calls
 * this module: handlers run their bodies directly, as they always have.
 *
 * **Not every ownership change is queued.** Three run synchronously where
 * they are: the tab-close point (`onDocumentClosed`), the user-open default
 * (`applyUserOpenDefault`: `/api/open`, upload, scratchpad, startup; it only
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
 * **There is no timeout.** An operation that never settles (a save stalled on
 * a dead mount) holds every later MCP mutation of that document until the
 * server restarts. The design gives a bounded wait only to PR 5's route; a
 * wait bound here is a decision for the design, not this module.
 */

interface Chain {
  tail: Promise<void>;
  pending: number;
}

const chains = new Map<string, Chain>();

/**
 * Run `fn` after every operation already queued for `documentId` has settled.
 * A rejected or throwing operation does not break the chain: its failure goes
 * to its own caller and the next operation runs.
 */
export function runDocOp<T>(documentId: string, fn: () => Promise<T> | T): Promise<T> {
  const existing = chains.get(documentId);
  const mine = existing ?? { tail: Promise.resolve(), pending: 0 };
  if (!existing) chains.set(documentId, mine);
  mine.pending++;
  // The tail is replaced BEFORE `fn` can run, with a gate that opens when this
  // operation settles: an operation queued from inside `fn`'s synchronous head
  // (a lapse triggered by a claim, say) then waits for this one instead of
  // chaining onto the old, already-resolved tail.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const previous = mine.tail;
  mine.tail = gate;
  // An idle document starts its operation in this very tick, as a handler
  // with no queue would: the synchronous head of the body (and so the
  // ownership check and claim) runs before the caller's next line.
  const result = existing ? previous.then(fn) : startNow(fn);
  const done = () => {
    settle(documentId, mine);
    open();
  };
  result.then(done, done);
  return result;
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
 * nothing is in flight, and never in the middle of another record's operation.
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
  runDocOp(documentId, fn).catch(onError);
}

/** How many documents have a live chain. For "nothing was created" assertions. */
export function docOpQueueSizeForTests(): number {
  return chains.size;
}

/** Forget every chain. Operations already chained still run. */
export function resetDocOpQueuesForTests(): void {
  chains.clear();
}
