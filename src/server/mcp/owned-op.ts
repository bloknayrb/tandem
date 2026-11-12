/**
 * Ownership enforcement for MCP tools (#2358, ADR-054; ownership design §3.1, §5).
 *
 * **Where the check lives.** The ownership check, the claim of an unowned
 * document, the take rule and answered-once run here, in the MCP tool wrapper,
 * and nowhere else: not in `/api`, not in autosave or the reload family, not
 * in the annotation lifecycle or any shared service code. Those are the
 * user's own surface and never meet a check
 * (`tests/server/ownership-api-no-context.test.ts`).
 *
 * **Ships dark.** With ownership off every helper here is a passthrough: the
 * tool's body runs directly, with the arguments it was given, exactly as
 * before this file existed. There is no queue and nothing is claimed.
 *
 * **Flag on, a write runs as:** resolve the document and answer anything
 * decided by the arguments or by facts fixed at open — before the queue,
 * claiming nothing — then, at the operation's turn in the document's queue and
 * with no `await` in between: the document is still open; the item was not
 * already answered by another record; the caller holds the document or may
 * claim it; then the body. **The claim of an unowned document takes effect
 * at the body's outcome**, not at the check (PR 2a): while the body runs the
 * document still reads as unowned to everything outside the queue; a body
 * that ends in a refusal that never claims, or throws, leaves ownership
 * exactly as it was; and a body that keeps its claim makes the caller the
 * owner inside the queued operation, before it returns, so the next
 * operation in the queue finds the claim in effect. The body receives the
 * **pinned document id** and resolves its Y.Doc, store and typing marker from
 * it, so a tab change, a close or a Y.Doc swap while the call waited cannot
 * send the write anywhere but the document that was checked.
 *
 * **This is the only tool-side file that reads `caller.ownerId`.** Tool files
 * pass `caller` through opaquely, and a refusal names a record by its label
 * and display kind only: an `http:` owner id is that transport's bearer
 * session id (`tests/server/ownership-source-pins.test.ts`).
 */

import { ownershipEnabled } from "../ownership-flag.js";
import type { ToolCaller } from "../sessions/caller.js";
import { getCurrentDoc, hasDoc } from "./document-service.js";

export type { ToolCaller };

import {
  DOC_OP_WAIT_MS,
  DocOpCancelled,
  DocOpWaitExpired,
  runDocOp,
} from "../sessions/doc-op-queue.js";
import {
  beginWriteClaim,
  callerView,
  checkWrite,
  decideTake,
  dropWriteClaim,
  type HolderView,
  heldDocumentIds,
  type InboxScope,
  inboxScopeOf,
  logLimited,
  type OwnershipRefusal,
  otherAnswererOf,
  otherHolderOf,
  type PendingClaim,
  recordAnswerer,
  settleWriteClaim,
  takeDocument,
} from "../sessions/ownership.js";
import {
  documentBusyRefusal,
  notDocOwnerRefusal,
  type RefusalFamily,
} from "../sessions/ownership-refusal.js";
import { isErrorEnvelope, type McpToolResult, mcpError } from "./response.js";

/** Whether ownership is enforced. The only flag read the tool files need. */
export function ownershipOn(): boolean {
  return ownershipEnabled();
}

/**
 * Envelopes whose refusal was decided by the call's arguments or by a fact
 * fixed when the document was opened (its format, its source, read-only).
 * Such a refusal **never claims** (ownership design §5.1): where one is
 * answered inside the operation, on an unowned document the caller could have
 * claimed, the claim is never applied. A WeakSet, as `mcpError`'s own marker is, so nothing shows
 * on the wire. Marking is a no-op in effect while ownership is off.
 */
const neverClaims = new WeakSet<McpToolResult>();

/** Mark `result` as a refusal that must not leave a claim behind. Returns it. */
export function noClaim<T extends McpToolResult>(result: T): T {
  neverClaims.add(result);
  return result;
}

/**
 * Whether a `validateRange` rejection was decided by the offsets alone, with
 * no look at the document: a fractional offset, an inverted range, an empty
 * one (the check is reached only when `from === to`), or a negative start (a
 * negative end with a start at or above zero is already `inverted`).
 * An offset past the end, a stale snapshot and a heading overlap depend on
 * live content and keep a claim (ownership design §5.1).
 */
export function rangeDecidedByArguments(reason: string | undefined, from: number): boolean {
  if (reason === "non-integer" || reason === "inverted" || reason === "empty") return true;
  return reason === "out-of-bounds" && from < 0;
}

function noOwner(tool: string): McpToolResult {
  return mcpError(
    "INTERNAL_ERROR",
    `${tool} refused: this request carries no owner identity. ` +
      "This is a Tandem wiring fault, not something to retry with different arguments.",
  );
}

function refusalEnvelope(
  refusal: OwnershipRefusal,
  documentId: string,
  ownerId: string,
  opts: { family?: RefusalFamily; defaulted?: boolean; openedAnyway?: boolean } = {},
): McpToolResult {
  const view = callerView(ownerId);
  const { message, details } = notDocOwnerRefusal({
    reason: refusal.reason,
    cause: refusal.cause,
    holder: refusal.holder,
    documentId,
    family: opts.family,
    targetWasDefaulted: opts.defaulted,
    heldDocumentIds: opts.defaulted ? heldDocumentIds(ownerId) : undefined,
    callerIsTandem: view?.isTandem,
    callerIsLegacyClaudeCode: view?.isLegacyClaudeCode,
    openedAnyway: opts.openedAnyway,
  });
  return mcpError("NOT_DOC_OWNER", message, details);
}

/**
 * The answer for a call that left the document's queue without running: it
 * waited past the limit, or its request was cancelled before its turn. Null
 * for any other failure, which the caller rethrows. Nothing was claimed (a
 * claim is applied only at the outcome of an operation, and this one never ran).
 */
function busyEnvelope(err: unknown, documentId: string): McpToolResult | null {
  const reason =
    err instanceof DocOpWaitExpired
      ? "wait-expired"
      : err instanceof DocOpCancelled
        ? "cancelled"
        : null;
  if (reason === null) return null;
  const { message, details } = documentBusyRefusal({
    reason,
    documentId,
    waitedMs: err instanceof DocOpWaitExpired ? err.waitedMs : undefined,
  });
  return mcpError("DOCUMENT_BUSY", message, details);
}

/**
 * How long the take of a document this call just created may wait for that
 * document's queue. Short: the call has already had its own wait, and the
 * two together must stay under the stdio bridge's request timeout.
 */
export const FRESH_TAKE_WAIT_MS = 2_000;

/** Which document a write targets, as the tool resolves it today. */
export type WriteTarget =
  /** An open document. `defaulted`: the call named none, so this is the active one. */
  | { open: true; documentId: string; defaulted: boolean }
  /**
   * Nothing to check: no such document is open. The body runs with `given`
   * and gives its own not-open answer, as it does today.
   */
  | { open: false };

/**
 * The target of a write as every write tool resolves it today: the named
 * document, or the active one when none is named. An id that is not open —
 * including the empty string, which is never defaulted — has no target.
 */
export function writeTarget(documentId: string | undefined): WriteTarget {
  const current = getCurrentDoc(documentId);
  if (!current) return { open: false };
  return { open: true, documentId: current.id, defaulted: documentId === undefined };
}

export interface OwnedWriteSpec {
  /** The `documentId` the body is called with when ownership is off, or the document is not open. */
  given: string | undefined;
  /** Resolve the target. Called only with ownership on. */
  resolve: () => WriteTarget;
  /**
   * Refusals decided by the arguments or by facts fixed at open, in the order
   * the body already answers them. Answered before the queue, so they never
   * claim and never wait.
   */
  preflight?: (documentId: string) => McpToolResult | null;
  /** Which `default` / `claimed` sentence applies (ownership design §5.3). */
  family?: RefusalFamily;
  /**
   * The id-keyed tools: true when the pinned document holds no record for the
   * annotation id. Nothing exists to write, so the body answers its own
   * `NOT_FOUND` unchecked and unclaimed, whoever holds the document.
   */
  nothingToWrite?: (documentId: string) => boolean;
  /**
   * `tandem_annotationReply`: the thread item this reply would answer
   * (ownership design §5.5), or null when the thread has none the caller can see.
   */
  answers?: (documentId: string) => { annotationId: string; item: string } | null;
}

/**
 * Run a write tool's body under ownership. See the module header for the
 * order. `body` is today's handler body, taking the document id to act on.
 *
 * Deliberately not `async`: with ownership off it returns the body's own
 * promise, so a dark build adds no queue and no extra tick.
 */
export function ownedWrite(
  caller: ToolCaller,
  tool: string,
  spec: OwnedWriteSpec,
  body: (documentId: string | undefined) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (!ownershipEnabled()) return body(spec.given);
  const ownerId = caller.ownerId;
  if (ownerId === undefined) return Promise.resolve(noOwner(tool));
  const target = spec.resolve();
  if (!target.open) return body(spec.given);
  const { documentId, defaulted } = target;
  const early = spec.preflight?.(documentId);
  if (early) return Promise.resolve(early);

  // Set when the operation's turn comes. The busy answer says "not run,
  // nothing changed", so it is given only for a call that never started: a
  // queue error escaping from inside a body is a fault, not this.
  let started = false;
  return runDocOp(
    documentId,
    async () => {
      started = true;
      // Closed while this call waited: nothing to check and nothing to claim.
      // The body gives its own not-open answer for the id that was pinned.
      if (!hasDoc(documentId)) return body(documentId);
      if (spec.nothingToWrite?.(documentId)) return body(documentId);

      // Ownership design §5.3: the operation-specific rows come first, so "already answered" is
      // said before "someone else holds this" — a session told only the second
      // would take the document and then be refused anyway.
      const answering = spec.answers?.(documentId) ?? null;
      if (answering) {
        const other = otherAnswererOf(documentId, answering.annotationId, answering.item, ownerId);
        if (other) {
          return refusalEnvelope(
            { ok: false, reason: "answered", holder: other.holder },
            documentId,
            ownerId,
          );
        }
      }

      const decision = checkWrite(documentId, ownerId);
      if (!decision.ok) {
        return refusalEnvelope(decision, documentId, ownerId, { family: spec.family, defaulted });
      }

      // The claim of an unowned document is pending until the body's outcome
      // is known, and invisible meanwhile. A body that throws wrote nothing
      // it can vouch for, and a refusal that never claims decided nothing
      // about the document: both end with the token dropped (the `finally`)
      // and ownership exactly as it was.
      let pending: PendingClaim | null = decision.claim
        ? beginWriteClaim(documentId, ownerId)
        : null;
      try {
        const result = await body(documentId);
        // The write has happened. Nothing from here on may fail the call: a
        // client told INTERNAL_ERROR would retry and write twice.
        if (neverClaims.has(result)) return result;
        const failed = () =>
          logLimited(
            "write-outcome",
            `[Tandem] ${tool} ran, but recording its ownership outcome failed; its result is returned as it was`,
          );
        // Answered-once and the claim do not depend on each other, in either
        // direction: the answer is on the thread whether or not the caller
        // ends up holding the document (it closed meanwhile, its record is
        // gone), and a failure recording one must not skip the other.
        try {
          if (answering && !isErrorEnvelope(result)) {
            recordAnswerer(documentId, answering.annotationId, answering.item, ownerId);
          }
        } catch {
          failed();
        }
        try {
          if (pending) {
            // Cleared only once it is settled: if reading the registry
            // throws, the `finally` still drops the token.
            settleWriteClaim(pending, hasDoc(documentId));
            pending = null;
          }
        } catch {
          failed();
        }
        return result;
      } finally {
        if (pending) dropWriteClaim(pending);
      }
    },
    { signal: caller.signal },
  ).catch((err: unknown) => {
    const busy = started ? null : busyEnvelope(err, documentId);
    if (busy) return busy;
    throw err;
  });
}

const RETRY = Symbol("retry");

/**
 * An `expectTargetId` no document can match (ids are hashes and basenames; a
 * NUL is in neither): an open told to expect it refuses before it acts.
 */
const NO_TARGET = "\u0000no-target";

export interface OwnedOpenSpec {
  /**
   * The id of the document this open targets — the open document that already
   * holds this file, or the id a fresh open would get — or undefined when the
   * path will be refused before anything is opened (the open is then run
   * with a target it cannot match, so it can only refuse). Synchronous.
   */
  predict: () => string | undefined;
  /**
   * Run the open. With `expectTargetId` (undefined only while ownership is
   * off), it must act only on that target and
   * report `targetChanged` instead when the file's open document is another
   * one by the time it looks. `openedId` is the document now open, when the
   * open succeeded.
   */
  open: (
    expectTargetId: string | undefined,
  ) => Promise<{ envelope: McpToolResult; openedId?: string; targetChanged?: boolean }>;
}

/**
 * `tandem_open` under ownership: the take rule (ownership design §4.2, §5.4).
 *
 * The open runs in its target document's queue. First thing inside, the take
 * is decided: an `opened` or `assigned` document held by another record is
 * refused **before any reload, activation or authorship stamp**. Then the
 * open; then the take is applied to the document that is now open. A file
 * that fails to open leaves no entry. A take wakes nobody.
 *
 * The target is predicted before the queue and can move while the call waits
 * (a rename, a repointed link). The operation then leaves its slot and the
 * call starts again under the new target — outside the old slot, so two
 * queues never wait on each other — at most three times.
 */
export async function ownedOpen(
  caller: ToolCaller,
  tool: string,
  spec: OwnedOpenSpec,
): Promise<McpToolResult> {
  if (!ownershipEnabled()) return (await spec.open(undefined)).envelope;
  const ownerId = caller.ownerId;
  if (ownerId === undefined) return noOwner(tool);

  // One deadline for the whole call, however many times it starts again. A
  // hop that finds its queue idle runs whatever is left of it, so only a busy
  // queue refuses. The time an earlier hop spent running does count: after a
  // hop whose open ran past the deadline, the next one is refused by a busy
  // queue at once.
  const deadline = Date.now() + DOC_OP_WAIT_MS;
  for (let hop = 0; hop < 3; hop++) {
    const predicted = spec.predict();
    if (predicted === undefined) {
      // The path is one the open path refuses, so this open is expected to
      // fail and nothing is checked. It is given a target no document can
      // have, so it CANNOT act: if the path stopped being refused since the
      // prediction, the open reports a changed target having done nothing,
      // and the call starts again under a real prediction, in that
      // document's queue. Nothing is ever opened, reloaded or taken here.
      const refused = await spec.open(NO_TARGET);
      if (refused.targetChanged) continue;
      if (refused.openedId !== undefined) {
        throw new Error("an open with no target opened a document");
      }
      return refused.envelope;
    }
    let outcome: McpToolResult | typeof RETRY;
    let started = false;
    try {
      outcome = await runDocOp<McpToolResult | typeof RETRY>(
        predicted,
        async () => {
          started = true;
          if (spec.predict() !== predicted) return RETRY;
          const before = decideTake(predicted, ownerId);
          if (!before.ok) return refusalEnvelope(before, predicted, ownerId);
          const opened = await spec.open(predicted);
          if (opened.targetChanged) return RETRY;
          if (opened.openedId === undefined || !hasDoc(opened.openedId)) return opened.envelope;
          const taken = takeDocument(opened.openedId, ownerId);
          if (!taken.ok) {
            return refusalEnvelope(taken, opened.openedId, ownerId, { openedAnyway: true });
          }
          return opened.envelope;
        },
        { signal: caller.signal, waitMs: Math.max(0, deadline - Date.now()) },
      );
    } catch (err) {
      const busy = started ? null : busyEnvelope(err, predicted);
      if (busy) return busy;
      throw err;
    }
    if (outcome !== RETRY) return outcome;
  }
  return mcpError(
    "RELOAD_IN_PROGRESS",
    "The open document for this file changed repeatedly while this call waited. Nothing was opened. Retry tandem_open.",
  );
}

/**
 * A document this call just created (`tandem_scratchpad`, the Markdown file
 * `tandem_convertToMarkdown` wrote) becomes the caller's under the take rule,
 * at its turn in that document's own queue (waiting for it only briefly: if
 * it stays busy the document is left untaken). The take rule decides, as it does
 * for `tandem_open`: an unowned document, or one another record holds as
 * `claimed` or `default`, becomes the caller's (and that record is told it
 * lost it); one another record holds as `opened` or `assigned` stays theirs
 * and the call still succeeds. Another record can hold it only if it got
 * there between the creation and this turn, or — `tandem_convertToMarkdown`
 * alone — if the Markdown file's document was already open while its file
 * was missing from disk, so the conversion wrote the file under it.
 */
export async function takeFreshDocument(caller: ToolCaller, documentId: string): Promise<void> {
  if (!ownershipEnabled()) return;
  const ownerId = caller.ownerId;
  if (ownerId === undefined) return;
  try {
    // No signal: the document already exists, so there is nothing to skip.
    await runDocOp(
      documentId,
      () => {
        if (hasDoc(documentId)) takeDocument(documentId, ownerId);
      },
      { waitMs: FRESH_TAKE_WAIT_MS },
    );
  } catch (err) {
    // The new document's queue stayed busy. The document exists and the call
    // that made it succeeded; it is simply not taken (the next write claims
    // it). Nothing escapes into the calling tool's own error mapping.
    if (!(err instanceof DocOpWaitExpired)) throw err;
    logLimited(
      "fresh-take-wait",
      "[Tandem] A newly created document was not taken by its creator: its operation queue was busy",
    );
  }
}

/**
 * `tandem_switchDocument` (ownership design §5.6): owner-only where an owner
 * exists, never claims. The refusal, or null to go ahead.
 */
export function switchRefusal(
  caller: ToolCaller,
  tool: string,
  documentId: string,
): McpToolResult | null {
  if (!ownershipEnabled()) return null;
  const ownerId = caller.ownerId;
  if (ownerId === undefined) return noOwner(tool);
  const other = otherHolderOf(documentId, ownerId);
  if (!other) return null;
  return refusalEnvelope(
    { ok: false, reason: "switch", holder: other.holder },
    documentId,
    ownerId,
  );
}

/**
 * Write-mode `tandem_status` (ownership design §5.2): whether another record
 * holds the document, in which case a focus is ignored rather than refused.
 * `"no-owner"` is the wiring fault every other helper refuses.
 */
export function focusHeldByAnother(caller: ToolCaller, documentId: string): boolean | "no-owner" {
  if (!ownershipEnabled()) return false;
  const ownerId = caller.ownerId;
  if (ownerId === undefined) return "no-owner";
  return otherHolderOf(documentId, ownerId) !== null;
}

/** The wiring-fault refusal, for a tool that asked {@link focusHeldByAnother}. */
export function noOwnerRefusal(tool: string): McpToolResult {
  return noOwner(tool);
}

/**
 * How the caller is described back to itself by read-mode `tandem_status`
 * (ownership design §5.7), so the user can ask a session which one it is.
 * Undefined while ownership is off, and for a caller with no record.
 */
export function callerOwnerInfo(
  caller: ToolCaller,
): (HolderView & { holding: string[] }) | undefined {
  if (!ownershipEnabled() || caller.ownerId === undefined) return undefined;
  const view = callerView(caller.ownerId);
  if (!view) return undefined;
  return {
    label: view.label,
    displayKind: view.displayKind,
    holding: heldDocumentIds(caller.ownerId),
  };
}

/**
 * Where the caller stands on an open document for an inbox poll (ownership
 * design §6.2): `"holds"`, `"may-claim"` or `"neither"`. The tool-side name
 * of the scope read. **The inbox does not use it**: `awareness.ts` may not
 * import this file, so since the scope PR it reaches the same read through
 * `inboxOwnership` in `sessions/ownership.ts`. Nothing in production calls
 * this. `"neither"` while ownership is off (`inboxScopeOf`'s own guard), and
 * for a caller with no owner id or no owner record.
 */
export function inboxScope(caller: ToolCaller, documentId: string): InboxScope {
  return inboxScopeOf(documentId, caller.ownerId);
}

/**
 * Of `candidates`, the documents the caller holds — for the id-keyed tools'
 * "pass documentId" refusal. Undefined while ownership is off, and when the
 * caller holds none of them.
 */
export function heldAmong(caller: ToolCaller, candidates: readonly string[]): string[] | undefined {
  if (!ownershipEnabled() || caller.ownerId === undefined) return undefined;
  const held = new Set(heldDocumentIds(caller.ownerId));
  const among = candidates.filter((id) => held.has(id));
  return among.length > 0 ? among : undefined;
}
