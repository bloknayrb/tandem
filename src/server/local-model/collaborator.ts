/**
 * Local-model collaborator wiring (#1123 M1.2, ADR-039).
 *
 * The ONLY server importer of the `local-model/` engine. Bridges the event queue
 * to `runLocalModelTurn`: wake on a user `chat:message`, run one loop turn
 * against the active document, and STREAM the reply token-by-token back into the
 * chat sidebar. Ships DARK — `startLocalModelCollaborator()` early-returns when
 * `BYO_MODELS_ENABLED` is false (the subscriber is never registered), and even
 * if the flag flips, `config-source.ts` returns null until M1a (no loop runs).
 *
 * Design (see plan §3):
 *  - ADR-039 "one active agent at a time": a single-flight controller; a new
 *    message SUPERSEDES the prior run (abort + serialize, then start) [D-B].
 *  - "Hold in Solo": the collaborator only acts in Tandem mode [D-D].
 *  - Self-wake safety: all chat writes go through `appendClaudeChatMessage` /
 *    `updateClaudeChatMessage` (withMcp + author:"claude") so the ctrl-chat
 *    observer skips them — a streamed delta can never re-trigger this subscriber.
 *  - Nested-txn safety: the queue callback does ZERO synchronous Y.Doc writes;
 *    the controller is handed off via `queueMicrotask`, and the streaming sink
 *    flushes only from a deferred timer — never synchronously on a delta stack.
 *  - License: the loop bypasses Surfaces A/B; the engine's dispatch-time gate
 *    (M1.1) is the only one. The chat write-back is intentionally ungated (the
 *    read-only/chat escape hatch).
 */
import { BYO_MODELS_ENABLED } from "../../shared/constants.js";
import type { ChatMessagePayload, TandemEvent } from "../../shared/events/types.js";
import type { AgentIdentity } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { getActiveDocId, requireDocument } from "../documents/registry.js";
import { subscribe, unsubscribe } from "../events/queue.js";
import { appendClaudeChatMessage, updateClaudeChatMessage } from "../mcp/awareness.js";
import { extractText } from "../mcp/document.js";
import { readLiveMode } from "../mode.js";
import { pushNotification } from "../notifications.js";
import type { LocalModelConfig } from "./config.js";
import { resolveLocalModelConfig } from "./config-source.js";
import { type LoopMetrics, type LoopResult, type RunTurnOpts, runLocalModelTurn } from "./index.js";

/** Inline the whole document into the prompt below this length; else windowed reads. */
const INLINE_CHAR_LIMIT = 8000;
/** Coalesce streamed deltas: flush at most this often OR every FLUSH_CHARS chars. */
const STREAM_FLUSH_MS = 120;
const STREAM_FLUSH_CHARS = 80;
/** Truncate selectedText before embedding in the model prompt. A large selection
 *  can't inflate token usage unboundedly; 500 chars captures any reasonable
 *  user-selected excerpt (a paragraph or two). */
const SELECTION_TEXT_CAP = 500;

/** Injectable seams so the controller is unit-testable without a live model or
 *  the real event queue. Production uses the defaults. */
export interface CollaboratorDeps {
  runTurn: (opts: RunTurnOpts) => Promise<LoopResult>;
  resolveConfig: () => LocalModelConfig | null;
  subscribe: (cb: (e: TandemEvent) => void) => void;
  unsubscribe: (cb: (e: TandemEvent) => void) => void;
}

const DEFAULT_DEPS: CollaboratorDeps = {
  runTurn: runLocalModelTurn,
  resolveConfig: resolveLocalModelConfig,
  subscribe,
  unsubscribe,
};

interface RunReq {
  docName: string;
  task: string;
  selection?: ChatMessagePayload["selection"];
  replyTo?: string;
}

interface RunSlot {
  promise: Promise<void>;
  abort: AbortController;
  docName: string;
  token: object;
}

function composeTask(text: string, selection?: ChatMessagePayload["selection"]): string {
  if (selection?.selectedText) {
    const raw = selection.selectedText;
    const sel = raw.length > SELECTION_TEXT_CAP ? raw.slice(0, SELECTION_TEXT_CAP) + "..." : raw;
    return `${text}\n\nThe user has selected: "${sel}"`;
  }
  return text;
}

/**
 * Map a failed run to a FIXED user-facing string. `metrics.errorMessage` is READ
 * to pick the bucket but NEVER embedded in the output (a third-party body /
 * V8-parse snippet must not reach the UI — it stays on stderr). Structural
 * redaction, per plan §3.6.
 */
export function classifyFailure(metrics: LoopMetrics): string {
  const m = metrics.errorMessage ?? "";
  if (/non-JSON response/.test(m)) return "The local model returned an unreadable response.";
  if (/invalid local-model endpoint/.test(m)) return "The local model endpoint is misconfigured.";
  if (/exceeded .*cap/.test(m)) return "The local model response was too large and was stopped.";
  if (/HTTP \d/.test(m)) return "The local model server returned an error.";
  if (/abort/i.test(m)) return "The local model request was interrupted.";
  return "The local model could not reach the server or complete the request.";
}

export function createLocalModelCollaborator(deps: CollaboratorDeps = DEFAULT_DEPS) {
  let cachedConfig: LocalModelConfig | null = null;
  let subscriberCb: ((e: TandemEvent) => void) | null = null;
  let current: RunSlot | null = null;

  /**
   * Per-run streaming sink. Owns ONE live chat message + a coalescing buffer +
   * AT MOST one scheduled flush. `push` (the onContentDelta) NEVER writes
   * synchronously; every flush is ownership-gated; a tool-call turn resets the
   * buffer so its preamble is REPLACED (never blanked) by the next turn.
   */
  function makeSink(ctx: {
    docName: string;
    replyTo?: string;
    token: object;
    abort: AbortController;
    /** #1123 M3: stamped on the streamed chat reply so the bubble bylines the
     *  specific local model. Absent ⇒ no stamp (byte-identical to pre-M3). */
    agentIdentity?: AgentIdentity;
  }) {
    let liveId: string | null = null;
    let buffer = "";
    let charsSinceFlush = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isOwner = () =>
      current?.token === ctx.token &&
      !ctx.abort.signal.aborted &&
      requireDocument(ctx.docName) !== null;

    const cancelTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // The single write path. Cancels the pending timer first (so a stale flush
    // can never land after a reset/final write), then commits the buffer if we
    // still own the run; no-op on an empty buffer (never mint/write "").
    const write = () => {
      cancelTimer();
      charsSinceFlush = 0;
      if (!isOwner() || buffer.length === 0) return;
      if (liveId === null) {
        liveId = appendClaudeChatMessage(buffer, {
          documentId: ctx.docName,
          ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}),
          ...(ctx.agentIdentity ? { agentIdentity: ctx.agentIdentity } : {}),
        });
      } else {
        updateClaudeChatMessage(liveId, buffer);
      }
    };

    return {
      push: (delta: string) => {
        buffer += delta;
        charsSinceFlush += delta.length;
        // Deferred always — a flush must never run on the onContentDelta stack.
        if (charsSinceFlush >= STREAM_FLUSH_CHARS) {
          cancelTimer();
          timer = setTimeout(write, 0);
        } else if (!timer) {
          timer = setTimeout(write, STREAM_FLUSH_MS);
        }
      },
      onTurnEnd: (info: { hadToolCalls: boolean }) => {
        if (info.hadToolCalls) {
          // The turn's content was preamble/scaffolding — drop it so the next
          // turn's content replaces it (no "" write → no empty-bubble flip).
          cancelTimer();
          buffer = "";
          charsSinceFlush = 0;
        }
      },
      flushFinal: () => write(),
      dispose: () => cancelTimer(),
    };
  }

  async function executeRun(req: RunReq, abort: AbortController, token: object): Promise<void> {
    // Still the owning, non-aborted run on a still-open doc? Evaluated at the top
    // (before work) and again at terminal time — the doc may close or this run be
    // superseded during the model turn. `requireDocument` never fabricates a
    // phantom room. Mirrors the sink's `isOwner()`.
    const stillOwner = () =>
      current?.token === token && !abort.signal.aborted && requireDocument(req.docName) !== null;

    // Resolve the live Y.Doc — bail if it vanished or we were superseded during
    // the supersede-await.
    const open = requireDocument(req.docName);
    if (!open || !stillOwner()) return;
    if (!cachedConfig) return;
    const config = cachedConfig; // capture: `let` widens back to |null across the await

    const ydoc = open.doc;
    const includeFullText = extractText(ydoc).length <= INLINE_CHAR_LIMIT;
    const task = composeTask(req.task, req.selection);
    // #1123 M3: the streamed chat reply is bylined with the config's prebuilt
    // identity (the loop's annotation/reply writes get the same one in dispatch).
    const sink = makeSink({
      docName: req.docName,
      replyTo: req.replyTo,
      token,
      abort,
      agentIdentity: config.agentIdentity,
    });

    try {
      const result = await deps.runTurn({
        ydoc,
        config,
        task,
        includeFullText,
        signal: abort.signal,
        onContentDelta: sink.push,
        onTurnEnd: sink.onTurnEnd,
      });

      // Ownership-gated terminal actions. A superseded / closed-doc / aborted run
      // drops its output silently (its last streamed partial stays in place).
      if (stillOwner()) {
        const exit = result.metrics.exit;
        if (exit === "clean") {
          sink.flushFinal();
        } else if (exit === "max_turns" || exit === "max_tool_calls") {
          // Budget exhausted mid-task (the model looped on tool calls, or never
          // produced a final no-tool answer turn). Commit any partial content
          // (flushFinal no-ops if the last tool-call turn reset the buffer) AND
          // tell the user the reply is incomplete — otherwise they're left with a
          // stale/empty bubble and no "stopped early" signal.
          sink.flushFinal();
          pushNotification({
            id: generateMessageId(),
            type: "general-error",
            severity: "warning",
            message: "The local model stopped before finishing (it reached its step limit).",
            documentId: req.docName,
            timestamp: Date.now(),
          });
        } else if (exit === "error") {
          console.error(
            `[local-model] run error (exit=${exit}): ${result.metrics.errorMessage ?? "unknown"}`,
          );
          pushNotification({
            id: generateMessageId(),
            type: "general-error",
            severity: "warning",
            message: classifyFailure(result.metrics),
            documentId: req.docName,
            timestamp: Date.now(),
          });
        }
        // exit === "aborted" → intentionally silent (superseded / closed / switched).
      }
    } finally {
      // Kill any pending flush timer on EVERY exit (clean/error/abort/throw).
      sink.dispose();
    }
  }

  /**
   * Single-flight controller. Claims the slot synchronously, then (in the async
   * body) aborts + AWAITS the prior run before starting — so two loops never run
   * concurrently and a superseded run can't post a stale reply.
   */
  function run(req: RunReq): void {
    const prev = current;
    const abort = new AbortController();
    const token: object = {};
    // Claim the slot synchronously BEFORE the body runs, so executeRun's
    // ownership checks see this token even on the no-prev fast path. The
    // placeholder promise is overwritten on the next line, within this same
    // synchronous frame (no other code runs in between).
    const slot: RunSlot = { abort, docName: req.docName, token, promise: Promise.resolve() };
    current = slot;
    slot.promise = (async () => {
      try {
        if (prev) {
          prev.abort.abort();
          await prev.promise.catch(() => {});
        }
        await executeRun(req, abort, token);
      } catch (err) {
        // The detached promise must never reject (→ unhandledRejection → exit).
        console.error("[local-model] collaborator run failed", err);
      } finally {
        if (current?.token === token) current = null;
      }
    })();
  }

  /** Synchronous queue callback: ZERO Y.Doc writes, cheap, non-throwing. */
  function onEvent(event: TandemEvent): void {
    if (event.type === "document:closed") {
      if (event.documentId && current?.docName === event.documentId) current.abort.abort();
      return;
    }
    if (event.type === "document:switched") {
      // event.documentId is the NEW active doc — abort a run on a different doc.
      if (current && event.documentId && current.docName !== event.documentId) {
        current.abort.abort();
      }
      return;
    }
    if (event.type !== "chat:message") return;

    const task = event.payload.text?.trim();
    if (!task) return;
    if (readLiveMode() !== "tandem") return; // hold in Solo (D-D)
    // TODO(M4): once config re-resolution is dynamic, a config that resolves
    // null AFTER a successful boot is indistinguishable from the dark no-op here
    // — the boot breadcrumb in resolveLocalModelConfig() fires only once.
    // Re-resolve and/or log (rate-limited) so a post-boot misconfig isn't silent
    // across many chat messages.
    if (!cachedConfig) return; // inert when unconfigured (M1a)
    const docName = event.documentId ?? getActiveDocId();
    if (!docName) return;
    if (!requireDocument(docName)) return; // never fabricate a phantom room

    // Hand off OFF the synchronous emit path (the callback runs inside the
    // originating browser-origin txn; a sync write here would be mis-tagged).
    queueMicrotask(() =>
      run({
        docName,
        task,
        selection: event.payload.selection,
        replyTo: event.payload.messageId,
      }),
    );
  }

  // Resolve config + register the subscriber. Split from start() so tests can
  // exercise the real subscribe/unsubscribe pairing without the compile-time
  // dark gate (which always early-returns in test builds).
  function wire(): void {
    cachedConfig = deps.resolveConfig();
    if (!cachedConfig) {
      console.error(
        "[local-model] collaborator: no config resolved — inert until configured (M1a)",
      );
    }
    subscriberCb = onEvent;
    deps.subscribe(subscriberCb);
  }

  function start(): void {
    if (!BYO_MODELS_ENABLED) return; // DARK: never subscribe, never read config
    wire();
  }

  async function stop(): Promise<void> {
    if (subscriberCb) {
      deps.unsubscribe(subscriberCb);
      subscriberCb = null;
    }
    if (current) {
      current.abort.abort();
      await current.promise.catch(() => {});
    }
  }

  return {
    start,
    stop,
    onEvent,
    /** test seam: resolve config + subscribe without the BYO flag gate. */
    __startForTests: wire,
    /** test seam: set config without the BYO flag gate (behavior tests). */
    __setConfigForTests: (c: LocalModelConfig | null) => {
      cachedConfig = c;
    },
    /** test seam: await the in-flight run (or resolve immediately if idle). */
    __awaitCurrent: () => current?.promise ?? Promise.resolve(),
    /** test seam: inspect the in-flight run's target doc (null when idle). */
    __currentDoc: () => current?.docName ?? null,
  };
}

// --- Production singleton -------------------------------------------------

let singleton: ReturnType<typeof createLocalModelCollaborator> | null = null;

/** Start the local-model collaborator (no-op + inert while dark). Idempotent. */
export function startLocalModelCollaborator(): void {
  if (singleton) return;
  singleton = createLocalModelCollaborator();
  singleton.start();
}

/** Stop the collaborator: unsubscribe + abort any in-flight run. */
export async function stopLocalModelCollaborator(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
  singleton = null;
}
