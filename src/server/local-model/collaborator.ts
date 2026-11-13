/**
 * Local-model collaborator wiring (#1123 M1.2, ADR-039).
 *
 * The ONLY server importer of the `local-model/` engine. Bridges the event queue
 * to `runLocalModelTurn`: wake on a user `chat:message`, run one loop turn
 * against the active document, and STREAM the reply token-by-token back into the
 * chat sidebar. Ships DARK — `startLocalModelCollaborator()` early-returns when
 * `BYO_MODELS_ENABLED` is false (the subscriber is never registered).
 *
 * The model config is resolved on EVERY chat event from the registry cache, so
 * a model saved a moment ago is used by the next chat with no restart, and a
 * change (another default, disabled, another endpoint) applies to the next run.
 * A run already in flight carries the config it started with and finishes on
 * it. The editing permission is the opposite on purpose: it is read on every
 * tool call, so switching it off stops a run in flight from writing.
 *
 * Design (see PR #1160's "Product decisions wired in" table — no tracked
 * #1123 plan doc covers M1.2; #1160's own description is the record):
 *  - ADR-039 "one active agent at a time": a single-flight controller; a new
 *    message SUPERSEDES the prior run (abort + serialize, then start) [D-B].
 *  - Who answers chat (#1123, ADR-039 amendment 2026-11-12): one switch,
 *    Claude or the local model (`models/chat-answerer.ts`). With Claude chosen
 *    the collaborator runs nothing and posts nothing; a switch to Claude
 *    aborts a run in flight. With the local model chosen it answers every chat,
 *    in Tandem mode and in Solo — in Solo in the chat tier only, because Solo
 *    means the AI holds annotations. (This replaces "hold in Solo" [D-D].)
 *  - Chat notices (#1123): a chat the local model cannot answer — no document
 *    open, or no local model resolving — gets one short message in the chat,
 *    through `appendClaudeChatMessage` (so the licence suppresses it), marked
 *    `chatNotice` and never counted as an answer.
 *  - Self-wake safety: all chat writes go through `appendClaudeChatMessage` /
 *    `updateClaudeChatMessage` (withMcp + author:"claude") so the ctrl-chat
 *    observer skips them — a streamed delta can never re-trigger this subscriber.
 *  - Nested-txn safety: the queue callback does ZERO synchronous Y.Doc writes;
 *    the controller is handed off via `queueMicrotask`, and the streaming sink
 *    flushes only from a deferred timer — never synchronously on a delta stack.
 *  - License (#1521): the local model is an AI surface, so an unlicensed
 *    install runs no turn at all. Checked PER RUN in `onEvent` (a start-time
 *    check would need a restart after activation); the chat write-back is
 *    refused by `appendClaudeChatMessage` too, so a licence that lapses before
 *    the run's first chat write ends the run; a reply already streaming
 *    finishes. The editor itself is never refused.
 */

import { createHash } from "node:crypto";
import { BYO_MODELS_ENABLED, CTRL_ROOM, Y_MAP_CHAT } from "../../shared/constants.js";
import type { ChatMessagePayload, TandemEvent } from "../../shared/events/types.js";
import { AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE } from "../../shared/license-copy.js";
import type { ChatAnswerer } from "../../shared/models/contract.js";
import { withMcp } from "../../shared/origins.js";
import type {
  AgentIdentity,
  ChatMessage,
  ChatNoticeKind,
  LocalRunState,
  LocalRunStopReason,
} from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { contentGeneration } from "../documents/content-generation.js";
import { getActiveDocId, requireDocument } from "../documents/registry.js";
import { type SubscriberKind, subscribe, unsubscribe } from "../events/queue.js";
import { type AiRefusal, aiRefusal } from "../license/ai-refusal.js";
import {
  appendClaudeChatMessage,
  finalizeClaudeChatMessage,
  updateClaudeChatMessage,
} from "../mcp/awareness.js";
import { extractText } from "../mcp/document.js";
import { lastLeftTandemTo, leftTandemEpoch, readModeState } from "../mode.js";
import { chatAnswerer, onChatAnswererChanged } from "../models/chat-answerer.js";
import {
  announceBaselineAdopted,
  announceLocalModelChange,
  announceStartupMismatch,
  answeringWasAnnounced,
  baselineAdoptionPending,
  finishFirstLitStart,
  isFirstLitStart,
  recordAnsweringNone,
  recordBaselineAnswering,
  recordSetByUser,
  retryUnsavedRecord,
} from "../models/local-model-announced.js";
import {
  type LocalModelEditingState,
  localModelEditingState,
} from "../models/local-model-settings.js";
import { LOCAL_RUN_GENERATION } from "../models/local-run-generation.js";
import { type ModelsFileChange, onModelsFileChanged } from "../models/registry.js";
import { pushNotification } from "../notifications.js";
import { addStartupNotice } from "../startup-notices.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import type { LocalModelConfig } from "./config.js";
import {
  type AnsweringLocalModel,
  answeringLocalModel,
  diagnoseLocalModel,
  type LocalModelUnusable,
  type LocalModelUnusableReason,
  resolveLocalModelConfig,
} from "./config-source.js";
import { type LoopMetrics, type LoopResult, type RunTurnOpts, runLocalModelTurn } from "./index.js";

/** Inline the whole document into the prompt below this length; else windowed reads. */
const INLINE_CHAR_LIMIT = 8000;
/** Coalesce streamed deltas: flush at most this often OR every FLUSH_CHARS chars. */
const STREAM_FLUSH_MS = 120;
const STREAM_FLUSH_CHARS = 80;

/**
 * Ceiling on a single streamed reply (#1292).
 *
 * Since #1340 each flush is a diff-splice into the `chatStream` sidecar
 * `Y.Text` — O(delta) on the wire — so the old O(n²) broadcast rationale is
 * gone. The cap is still load-bearing three ways: it bounds the per-flush CPU
 * (`updateClaudeChatMessage` reads the current text and scans a prefix, O(n)
 * per flush), it bounds what the finalize fold writes into the durable chat
 * row and hence the persisted session file, and it bounds the chat bubble a
 * user gets shown. A local model in a repetition loop (a routine failure mode
 * for quantized small models) reaches it with no attacker involved; the only
 * other ceiling is the per-response raw-byte cap, sized for a whole JSON
 * response rather than a chat bubble. 64 KiB is generous for a chat bubble.
 */
const MAX_STREAMED_CHARS = 64 * 1024;

/** Appended once when {@link MAX_STREAMED_CHARS} is hit, so the cut is visible. */
const TRUNCATION_MARKER = "\n\n_[Reply truncated — the model exceeded the streaming limit.]_";

/**
 * Wire-level twin of {@link MAX_STREAMED_CHARS} (#1292).
 *
 * The two caps must be compared in CONTENT chars, not in bytes, and doing that
 * inverts the naive reading: per-frame framing overhead means a streamed byte
 * budget buys far fewer content chars than its size suggests. Measured against
 * realistic frames carrying a 5-char token:
 *
 *   v1 SSE (id, object, created, model, system_fingerprint, choices[0].delta,
 *   logprobs, finish_reason)  ~264 B/frame  ->  ~53 B per content char
 *   Ollama-native NDJSON      ~132 B/frame  ->  ~26 B per content char
 *
 * At 1 MiB that admitted only ~20k (v1) / ~40k (native) content chars — both
 * BELOW the 64 KiB sink cap, so the wire cap always tripped first and the sink's
 * truncation marker was unreachable in production. 4 MiB clears the ~3.3 MiB a
 * v1 stream needs to deliver 64 KiB of content, restoring the intended order:
 * the sink cap is the primary bound (it is what shows the user a marker), this
 * is the backstop. Still four times below the client's 16 MB default, which
 * exists for whole-JSON reads rather than chat.
 *
 * What the raise actually costs is `readStream`'s line buffer, and the sink
 * cannot help there: the case that cap was added for is a newline-less flood,
 * where no frame ever completes, so no delta is ever emitted and the sink's
 * cap-abort can never fire. This constant is the only bound on that buffer.
 * 4 MiB of transient decode buffer against a loopback endpoint is the price of
 * making the sink's marker reachable at all.
 *
 * It cannot be ordered for EVERY stream: a degenerate one-char-token stream runs
 * ~260 B per content char and still trips this cap first. That path exits
 * `error`, which is why `executeRun`'s error branch also flushes the sink.
 */
const MAX_STREAMED_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Truncate selectedText before embedding in the model prompt. A large selection
 *  can't inflate token usage unboundedly; 500 chars captures any reasonable
 *  user-selected excerpt (a paragraph or two). */
const SELECTION_TEXT_CAP = 500;

/** Injectable seams so the controller is unit-testable without a live model or
 *  the real event queue. Production uses the defaults. */
export interface CollaboratorDeps {
  runTurn: (opts: RunTurnOpts) => Promise<LoopResult>;
  resolveConfig: () => LocalModelConfig | null;
  // `kind` is required, mirroring the real `subscribe`: it selects the WS-A2
  // privacy gate as well as diagnostic counting, so a test double that let it
  // default would stop modelling the thing this loop depends on (see `wire`).
  subscribe: (cb: (e: TandemEvent) => void, kind: SubscriberKind) => void;
  unsubscribe: (cb: (e: TandemEvent) => void) => void;
  /** The licence decision (#1521). Optional: absent means the live `aiRefusal`. */
  aiRefusal?: () => AiRefusal | null;
  /**
   * Why a selected local model cannot be used, consulted only when
   * `resolveConfig` answered null. Absent means "nothing to tell the user",
   * which is what a test double that only wants a config or none gets.
   */
  diagnose?: () => LocalModelUnusable | null;
  /**
   * The user's editing setting plus its Off counter (#1123). **Absent means no
   * writes** — the default is supplied only in `DEFAULT_COLLABORATOR_DEPS`, never by `??` at
   * the read, so a double that forgets it gets a chat-tier collaborator.
   */
  editingState?: () => LocalModelEditingState;
  /** Be told when the saved registry changes, and how (#2404: a change from
   *  Tandem's own window is the user's and is not announced); returns the
   *  unsubscribe. Absent means never told. A caller that passes no change is
   *  treated as an unspecified source, which is announced. */
  onModelsChanged?: (cb: (change?: ModelsFileChange) => void) => () => void;
  /** Which saved entry would answer the next chat, for the "it was changed"
   *  notice (#2404). Absent means that notice is never raised. */
  answering?: () => AnsweringLocalModel | null;
  /**
   * Who answers chat (#1123): `"local"` lets this collaborator answer.
   * **Absent means Claude** — the collaborator then runs nothing and posts
   * nothing — so a double that forgets it gets a silent collaborator, never a
   * second answerer. The default is supplied only in `DEFAULT_COLLABORATOR_DEPS`.
   */
  chatAnswerer?: () => ChatAnswerer;
  /** Be told when who answers chat changes; returns the unsubscribe. Shaped
   *  like `onModelsChanged`. Absent means never told: a run in flight is then
   *  stopped only by its own start-time check, not at the switch. */
  onChatAnswererChanged?: (cb: (now: ChatAnswerer) => void) => () => void;
  /**
   * The record of what the user chose in Tandem's own window, or was told
   * (`local-model-announced.ts`). With it, the model found at start-up raises
   * the start-up notice unless the record names exactly that model — so a file
   * changed underneath cannot become the silent baseline by restarting the
   * server. Absent (a test double), the start-up model is taken as the
   * baseline and notices are raised live and for replay without being recorded.
   */
  announced?: {
    wasAnnounced: (fingerprint: string) => boolean;
    /** A live warning, for a change NOT made from Tandem's own window. */
    announce: (dedupKey: string, message: string, fingerprint: string) => void;
    /** No local model answers any more: forget which one was recorded. */
    none: () => void;
    /** The user's own change made this model answer, or edited it: record it
     *  at once, no notice. Absent: nothing is recorded. */
    setByUser?: (fingerprint: string) => void;
    /** An own-window write that changed nothing recorded: retry a record
     *  write that failed. */
    retry?: () => void;
    /** Is this the first start with the flag on? Absent: never. */
    firstLitStart?: () => boolean;
    /** Take the model found at a first lit start as the baseline. */
    baseline?: (fingerprint: string) => void;
    /** Was this model adopted as the baseline with nobody yet told which? */
    adoptionPending?: (fingerprint: string) => boolean;
    /** Say which model the baseline adopted (held for Tandem's own window). */
    adopted?: (message: string) => void;
    /** Start-up found a model answering that the record does not name.
     *  Absent: the live notice is raised instead, as before #2404's fix. */
    startupMismatch?: (fingerprint: string) => void;
    /** Wiring is done: write the first-lit-start marker if it is missing. */
    finishStart?: () => void;
  };
}

/** Exported so a test can pin that production really wires each seam: every
 *  one of them fails closed when absent, so a dropped line here would turn a
 *  feature off without failing anything else. */
export const DEFAULT_COLLABORATOR_DEPS: CollaboratorDeps = {
  runTurn: runLocalModelTurn,
  resolveConfig: resolveLocalModelConfig,
  subscribe,
  unsubscribe,
  diagnose: diagnoseLocalModel,
  editingState: localModelEditingState,
  onModelsChanged: onModelsFileChanged,
  answering: answeringLocalModel,
  chatAnswerer,
  onChatAnswererChanged,
  announced: {
    wasAnnounced: answeringWasAnnounced,
    announce: (dedupKey, message, fingerprint) => {
      announceLocalModelChange(dedupKey, message, { answering: fingerprint });
    },
    none: () => recordAnsweringNone(ANSWERING_CHANGED_NOTICE_KEY),
    setByUser: (fingerprint) => {
      void recordSetByUser({ answering: fingerprint }, ANSWERING_CHANGED_NOTICE_KEY);
    },
    retry: retryUnsavedRecord,
    firstLitStart: isFirstLitStart,
    baseline: recordBaselineAnswering,
    adoptionPending: baselineAdoptionPending,
    adopted: (message) => {
      announceBaselineAdopted(message);
    },
    startupMismatch: (fingerprint) => {
      announceStartupMismatch({ answering: fingerprint });
    },
    finishStart: finishFirstLitStart,
  },
};

/** Identity of an answering model for the announced-record: the entry, where
 *  it points and which model it names. A hash, so the Endpoint is not written
 *  to a second file. */
export function answeringFingerprint(m: AnsweringLocalModel): string {
  return createHash("sha256")
    .update(JSON.stringify([m.entryId, m.endpoint, m.modelId]))
    .digest("hex");
}

/** Replay key of the "answering model was changed" notice. One key, so a
 *  burst of changes is one tray row with a count, and cannot push another
 *  notice (such as "commenting was switched on") out of the tray. */
export const ANSWERING_CHANGED_NOTICE_KEY = "local-model-answering-changed";

/** A saved display name, made safe to quote inside a notice: letters, digits
 *  and plain punctuation only (so no control, bidi or zero-width characters),
 *  and short enough that it cannot carry a message of its own. */
function quotableName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} _+()-]/gu, "")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? `"${cleaned}"` : "an unnamed model";
}

/**
 * What the user is told when their own change made a DIFFERENT model start
 * answering without their touching that model (#2404): with A the default and
 * B enabled, deleting A makes B answer. An info notice: it goes to the
 * activity tray and expires by itself. Never the Endpoint or the model id.
 */
export function answeringSwitchedNotice(now: AnsweringLocalModel): string {
  return `Your change means the local model ${quotableName(now.displayName)} is now the one used when your chat is answered by a local model.`;
}

/**
 * What the user is told, once, when the first start with local models on
 * found a model already saved and took it as their starting point (#2404).
 * Neutral: for nearly everyone it is their own model. It is said at all
 * because every release through v0.31.0 let another page on this computer save
 * one while local models were off. Never the Endpoint or the model id.
 */
export function baselineAdoptedNotice(now: AnsweringLocalModel): string {
  return `Local models are now available in Tandem. A local model was already saved, ${quotableName(now.displayName)}, and it is the one used when your chat is answered by a local model. If you did not add it, remove it in Settings → Models.`;
}

/**
 * Did this write add the entry, edit it, or make it the default? The route
 * receives a whole replacement file, not an intent, so it is decided by
 * comparing the file before and after. Both are the store's canonical form.
 */
export function entryTouchedByWrite(change: ModelsFileChange, entryId: string): boolean {
  const before = change.before.models.find((m) => m.id === entryId);
  const after = change.after.models.find((m) => m.id === entryId);
  if (!before || !after) return true;
  if (JSON.stringify(before) !== JSON.stringify(after)) return true;
  return change.after.defaultModelId === entryId && change.before.defaultModelId !== entryId;
}

/**
 * What the user is told when the local model that would answer their chat is
 * changed by a write that did not come from Tandem's own window (#2404) — the
 * development allowance; a change from Tandem's own window is the user's and
 * is not announced. A saved model takes effect on the next chat with no
 * restart, so such a change must not be silent. One text for every kind of change: it never carries
 * the Endpoint (which `GET /api/models` withholds from a non-loopback caller)
 * or the model id (which for llama.cpp is often a file path). Past tense,
 * because it stays in the activity tray.
 */
export function answeringChangedNotice(now: AnsweringLocalModel): string {
  return `The local model used when your chat is answered by a local model was set or changed: a model was chosen, or its Endpoint or model was edited. It was set to ${quotableName(now.displayName)}. If you did not do this, check Settings → Models.`;
}

/**
 * What the user is told when the local model they selected cannot be used
 * (#1123 R1.3). Fixed strings: never the endpoint, the model id or a path. The
 * observation is in the past tense because a warning stays in the activity
 * tray after the state it describes has been fixed (see the convention on
 * `TandemNotification.severity`); the instruction stays true.
 */
export const UNUSABLE_NOTICE: Record<LocalModelUnusableReason, string> = {
  "no-default-chosen":
    "Your saved local models did not answer, because none of them was marked Default. Mark one as Default in Settings → Models.",
  "endpoint-rejected":
    "Your local model did not answer, because its Endpoint was not accepted. It must be a plain http loopback address on this computer, such as http://127.0.0.1:11434, with no user name or password. Edit the model in Settings → Models, then send your message again.",
  "no-endpoint":
    "Your local model did not answer, because it had no Endpoint saved. Edit the model in Settings → Models, then send your message again.",
};

/**
 * The chat notices (#1123): one short message in the chat, per chat message
 * the local model could not answer. Fixed strings, never a model name,
 * endpoint or id. They name "Settings → Models" as the remedy; part B of the
 * series puts the switch there (or re-words these in the same PR).
 */
export const CHAT_NOTICE_TEXT: Record<ChatNoticeKind, string> = {
  "no-document":
    "The local model could not answer this message, because no document was open for it. Open the document you want to ask about and send your message again.",
  "no-local-model":
    "No local model could answer this message. Add or enable a local model in Settings → Models, or set who answers your chat back to Claude there.",
};

/**
 * The no-local-model chat notice for an unusable state: the same remedy as
 * that state's toast ({@link UNUSABLE_NOTICE}), so the first chat in a broken
 * state is never told two different things.
 */
export const CHAT_NOTICE_UNUSABLE_TEXT: Record<LocalModelUnusableReason, string> = {
  "no-default-chosen":
    "No local model could answer this message, because none of your saved local models was marked Default. Mark one as Default in Settings → Models, or set who answers your chat back to Claude there.",
  "endpoint-rejected":
    "No local model could answer this message, because its Endpoint was not accepted. Edit the model in Settings → Models, or set who answers your chat back to Claude there.",
  "no-endpoint":
    "No local model could answer this message, because it had no Endpoint saved. Edit the model in Settings → Models, or set who answers your chat back to Claude there.",
};

/**
 * Would a local model answer a chat now? The one sanctioned export across the
 * dark audit for the chat-answerer GET (#1123): `index.ts` imports it and
 * hands it to the models routes, so no other `local-model/` module is reached
 * from outside. Only the boolean: never which model, or where it points.
 */
export function localModelResolvesNow(): boolean {
  return resolveLocalModelConfig() !== null;
}

/**
 * Write the run state on the user's chat row (#1123 R3.4), `withMcp`. Only
 * when the row still exists and is the user's: a chat cleared mid-run gets
 * nothing. Read-modify-write in one synchronous step, against the live row, so
 * a concurrent `read`/`delivered` stamp is kept. The ctrl-chat observer emits
 * only on a user row's `add`, and `mcp` is in its skip set, so this update can
 * wake nothing.
 */
function writeLocalRun(
  messageId: string | undefined,
  state: Omit<LocalRunState, "generation">,
): void {
  if (!messageId) return;
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const live = chatMap.get(messageId);
  if (typeof live !== "object" || live === null) return;
  const row = live as ChatMessage;
  if (row.author !== "user") return;
  const localRun: LocalRunState = { ...state, generation: LOCAL_RUN_GENERATION };
  withMcp(ctrlDoc, () => chatMap.set(messageId, { ...row, localRun }));
}

interface RunReq {
  /** Resolved at the chat event; the run finishes on it whatever is saved later. */
  config: LocalModelConfig;
  docName: string;
  task: string;
  selection?: ChatMessagePayload["selection"];
  replyTo?: string;
  /** Set once this run wrote "running" (R3.4). */
  started?: boolean;
  /** Set when this run, instead of starting, posted a chat notice. */
  noticed?: boolean;
  /** Set when it threw before it started. */
  threw?: boolean;
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
 * redaction (#1123 M1.2 — no tracked #1123 plan doc covers it). Pinned by
 * `collaborator.test.ts`'s "surfaces an error exit as a structured
 * notification, never the raw error text" plus the table-driven
 * "maps … to a fixed string with no raw detail" cases; #1160's test plan
 * calls that pair `structured-failure-no-raw-leak`, which is a PR-body
 * label, not a name anything in `tests/` carries.
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

export function createLocalModelCollaborator(deps: CollaboratorDeps = DEFAULT_COLLABORATOR_DEPS) {
  /** The broken state the user was last told about, so one state is one notice. */
  let noticedStateKey: string | null = null;
  let stopWatchingModels: (() => void) | null = null;
  let stopWatchingAnswerer: (() => void) | null = null;
  /** The model that would answer as of the last registry change, or null when
   *  none would. A model answering after "none" is always announced. */
  let lastAnswering: AnsweringLocalModel | null = null;
  let subscriberCb: ((e: TandemEvent) => void) | null = null;
  let current: RunSlot | null = null;
  /** Which refusal was last logged, so a refused state logs once, not once per chat. */
  let loggedRefusal: AiRefusal["kind"] | null = null;
  const decideRefusal = deps.aiRefusal ?? aiRefusal;
  /** Who answers chat. No `chatAnswerer` dep at all means Claude. */
  const answerer = (): ChatAnswerer =>
    deps.chatAnswerer && deps.chatAnswerer() === "local" ? "local" : "claude";

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
    // Latch, not a counter: the marker is appended exactly once, and every
    // subsequent delta is dropped rather than re-triggering the cap branch.
    let truncated = false;

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
    // still own the run; no-op on an empty buffer (never mint/write ""). A
    // whitespace-only buffer counts as empty: the loop treats such a turn as
    // "said nothing" (`editing_off`), and a blank bubble beside that notice
    // would contradict it. Leading whitespace is only held back, not lost —
    // it is committed with the first visible character.
    const write = () => {
      cancelTimer();
      charsSinceFlush = 0;
      if (!isOwner() || buffer.trim().length === 0) return;
      if (liveId === null) {
        const appended = appendClaudeChatMessage(buffer, {
          documentId: ctx.docName,
          ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}),
          ...(ctx.agentIdentity ? { agentIdentity: ctx.agentIdentity } : {}),
        });
        if (!appended.ok) {
          // The licence lapsed between the run's start and its first write
          // (#1521): drop the run, write nothing. Once a row is minted the run
          // finishes, since the check is per run, not per write.
          logRefusal(appended.refusal);
          ctx.abort.abort();
          return;
        }
        liveId = appended.id;
      } else {
        updateClaudeChatMessage(liveId, buffer);
      }
    };

    return {
      push: (delta: string) => {
        // Post-cap deltas are dropped outright: the marker is already committed
        // and the run is aborting, so appending would only grow a buffer nobody
        // will write.
        if (truncated) return;

        buffer += delta;
        charsSinceFlush += delta.length;

        if (buffer.length >= MAX_STREAMED_CHARS) {
          // #1292. ORDER IS LOAD-BEARING — do not reorder these two calls.
          // `write()` returns early on `!isOwner()`, and `isOwner()` includes
          // `!ctx.abort.signal.aborted`, so aborting FIRST would permanently
          // disable the only write path: the marker would never reach the
          // Y.Map, and the user would see a silently truncated reply. The
          // terminal path in `executeRun` cannot rescue it either — its
          // `stillOwner()` carries the same abort clause.
          //
          // Both calls ride ONE deferred task so the ordering is guaranteed
          // while preserving this file's nested-txn invariant (see the header:
          // the sink flushes only from a timer, never on a delta stack).
          truncated = true;
          buffer = buffer.slice(0, MAX_STREAMED_CHARS) + TRUNCATION_MARKER;
          cancelTimer();
          timer = setTimeout(() => {
            write();
            ctx.abort.abort();
          }, 0);
          return;
        }

        // Deferred always — a flush must never run on the onContentDelta stack.
        if (charsSinceFlush >= STREAM_FLUSH_CHARS) {
          cancelTimer();
          timer = setTimeout(write, 0);
        } else if (!timer) {
          timer = setTimeout(write, STREAM_FLUSH_MS);
        }
      },
      onTurnEnd: (info: { hadToolCalls: boolean }) => {
        // Once truncated, the buffer holds the committed-or-committing marker.
        // Dropping it here would cancel the pending cap flush and wipe the
        // marker, which is the one write the user needs to see (#1292).
        if (truncated) return;
        if (info.hadToolCalls) {
          // The turn's content was preamble/scaffolding — drop it so the next
          // turn's content replaces it (no "" write → no empty-bubble flip).
          cancelTimer();
          buffer = "";
          charsSinceFlush = 0;
        }
      },
      flushFinal: () => write(),
      /** The reply row this run minted, if any (a partial one included). */
      replyId: () => liveId,
      // Runs in executeRun's `finally` on EVERY exit (clean/budget/timeout/
      // error after their flushFinal; abort/supersede; throw), and `run()`
      // awaits the previous slot's promise before starting the next executeRun
      // — so the finalize fold always lands before any successor stream and
      // never interleaves with one. Finalize is deliberately NOT ownership-
      // gated: it appends no content, only folds already-committed CRDT state,
      // and `isOwner()` is already false for a superseded/aborted run — gating
      // it would strand the truncation marker (#1292) and every superseded
      // stream's sidecar entry as a permanent leak (#1340).
      dispose: () => {
        cancelTimer();
        if (liveId !== null) finalizeClaudeChatMessage(liveId);
      },
    };
  }

  async function executeRun(req: RunReq, abort: AbortController, token: object): Promise<void> {
    // Resolve the live Y.Doc FIRST — bail if it vanished or we were superseded
    // during the supersede-await. `ydoc` must be bound before `stillOwner` is
    // DEFINED, not merely before its first call: the predicate closes over it,
    // and the top-of-run call below would otherwise hit the TDZ.
    const open = requireDocument(req.docName);
    if (!open) {
      // Closed while this run waited for its predecessor: the chat is told,
      // as one that arrived after the close would be (#1123 R3.2) — unless a
      // newer chat or a switch to Claude has superseded it.
      if (current?.token === token && !abort.signal.aborted && req.replyTo) {
        req.noticed = true;
        postNotice("no-document", req.replyTo);
      }
      return;
    }
    const ydoc = open.doc;

    // Still the owning, non-aborted run on the SAME Y.Doc instance we captured?
    // Evaluated at the top (before work) and again at terminal time — during the
    // model turn this run may be superseded, aborted, or have its document
    // closed OR REPLACED.
    //
    // The third conjunct tests IDENTITY, not presence (#1657). Hocuspocus swaps
    // a room's Y.Doc in `onLoadDocument` (merge state, `destroy()` the old one,
    // `documents.set(...)`), so a browser connecting mid-run leaves this run
    // holding a destroyed instance while the room stays open — and neither of
    // the other two conjuncts sees it: the token is unchanged and nothing
    // aborts. `requireDocument` re-resolves through the provider map on every
    // call (`registry.ts` → `getOrCreateDocument`), so the comparison actually
    // observes the swap. `?.doc === ydoc` is false when it returns null, so
    // identity SUBSUMES the old presence test and additionally rejects a
    // re-created instance.
    //
    // The sink's `isOwner()` deliberately DIVERGES and stays on presence:
    // `makeSink` writes only to `CTRL_ROOM` via `appendClaudeChatMessage` /
    // `updateClaudeChatMessage`, which a document-room swap never touches.
    //
    // #2039 extracts the identity conjunct so the loop's per-turn check and
    // this gate cannot drift apart.
    //
    // #2070: identity is necessary and NOT sufficient. Every content-replacing
    // reload (force-open, the source-view commit, the file-watcher reload,
    // restore, the external-conflict Reload) keeps the SAME instance and swaps
    // what is in it, so a turn whose prompt was built before the reload would
    // dispatch its quotes against text it never read — and a quote that still
    // occurs somewhere anchors and verifies perfectly. The content generation
    // (`documents/content-generation.ts`) is bumped inside each of those
    // transactions; captured here, before the prompt is built (it is built
    // synchronously inside `runTurn`), it makes "the document I reasoned about"
    // one predicate.
    const startGeneration = contentGeneration(ydoc);
    const docUnchanged = () => requireDocument(req.docName)?.doc === ydoc;
    const docCurrent = () => docUnchanged() && contentGeneration(ydoc) === startGeneration;
    const stillOwner = () => current?.token === token && !abort.signal.aborted && docCurrent();

    if (!stillOwner()) return;
    // The switch, re-checked where the run starts (#1123 R2.1): a switch to
    // Claude between the chat and this point means this run never starts.
    if (answerer() !== "local") return;
    const config = req.config;
    // How it ended, set in each terminal branch below and written in the
    // `finally` once the sink has folded its reply. Unset there means a throw.
    let ended: { status: "replied" | "stopped"; reason?: LocalRunStopReason } | null = null;

    // The editing permission for THIS run (#1123). Captured here, with no await
    // between this line and `runTurn` reading it, so the tier the engine picks
    // and the epoch this closure compares are the same instant. Any Off request
    // from now on changes the epoch, so the run cannot write again even if
    // editing is switched back on before its next tool call. No `editingState`
    // dep at all means no writes.
    //
    // The mode is part of the same permission (#1123 R3.1): Solo means the AI
    // holds annotations, so a run may comment or suggest only while the mode
    // is exactly "tandem" — compared at every tool call, as the editing
    // setting is — and only if the mode has not LEFT Tandem since the run
    // started (`leftTandemEpoch`), so Tandem → Solo → Tandem between two tool
    // calls still counts. A run that starts in Solo is a chat-tier run.
    const readEditing = deps.editingState;
    const startEpoch = readEditing ? readEditing().offEpoch : -1;
    const startLeftTandem = leftTandemEpoch();
    // A run that starts outside Tandem never edits, even once Tandem returns.
    const startMode = readModeState();
    const startedInTandem = startMode === "tandem";
    // Why the run was first refused a write, for the stop reason and toast:
    // Solo (the setting allowed it) or the editing setting itself.
    let refusedBy: "solo" | "mode-unknown" | "editing-off" | null = null;
    const editingAllowed = (): boolean => {
      if (!readEditing) return false;
      const now = readEditing();
      const settingAllows = now.enabled === true && now.offEpoch === startEpoch;
      const modeAllows =
        startedInTandem && readModeState() === "tandem" && leftTandemEpoch() === startLeftTandem;
      if (settingAllows && modeAllows) return true;
      // What refused it, judged from the mode the run started in AND the mode
      // now: a run that started outside Tandem was refused by that start
      // state; one that started in Tandem by what the mode is (or went
      // through) since. An absent mode key (`indeterminate`) is refused too —
      // it fails closed for privacy — but it is not Solo, so it is not called
      // Solo.
      if (refusedBy === null) {
        const now = readModeState();
        // Back in Tandem by the time it was refused: it was the trip out
        // (the epoch moved), so blame where the mode went.
        const blame = !startedInTandem ? startMode : now === "tandem" ? lastLeftTandemTo() : now;
        refusedBy = !settingAllows
          ? "editing-off"
          : blame === "indeterminate"
            ? "mode-unknown"
            : "solo";
      }
      return false;
    };

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

    // The run has started: say so on the user's row, for the editor (R3.4).
    // Immediately before the `try`, so its `finally` always writes the end.
    req.started = true;
    writeLocalRun(req.replyTo, { status: "running" });
    try {
      const result = await deps.runTurn({
        ydoc,
        config,
        task,
        includeFullText,
        // #1292: the client default is 16 MB, sized for a whole JSON response.
        // A chat reply is bounded by MAX_STREAMED_CHARS on the sink side; this
        // is the wire-level twin, so a hostile or looping endpoint cannot make
        // us buffer 16 MB before the sink ever sees it. Both are needed — the
        // sink cap bounds the Y.Map write, this bounds the raw read.
        maxResponseBytes: MAX_STREAMED_RESPONSE_BYTES,
        signal: abort.signal,
        onContentDelta: sink.push,
        onTurnEnd: sink.onTurnEnd,
        // #2039 / #2070: stop the loop at the next turn boundary once our
        // captured instance is no longer the room's live one, or its content
        // was replaced — and refuse each write dispatch on the same predicate.
        isDocCurrent: docCurrent,
        editingAllowed,
      });

      // #2039: the swap arm sits OUTSIDE the ownership gate, deliberately.
      // `stillOwner()` is false after a swap BY CONSTRUCTION (#1657), so an arm
      // inside that block would be dead code and the abort would ship silent —
      // exactly the bug. It carries no token test either: a run that is both
      // superseded and swapped may notify while a newer run is in flight, which
      // is judged better than the dead-code failure. Do not "tidy"
      // `current?.token === token` back in.
      //
      // No `sink.flushFinal()` here: dropping the terminal reply is #1657's
      // guarantee and stays. `sink.dispose()` in the `finally` still runs.
      //
      // Ownership-gated terminal actions. A superseded / closed-doc / aborted run
      // drops its output silently (its last streamed partial stays in place).
      if (result.metrics.exit === "doc-swapped") {
        const live = requireDocument(req.docName);
        // A null lookup means the document is CLOSED, not swapped — that
        // inherits the existing silent-drop contract. Since #2069 a close
        // normally arrives as an abort (`document:closed`) and exits `aborted`
        // before this; the null arm is the fallback for a close that lands
        // between the loop's abort re-check and its identity check. Telling a
        // user who just closed a tab that it "reconnected" names a remedy no
        // retry can satisfy. The ABORT is unchanged on every path; only the
        // message differs.
        // Closed → aborted; the same instance → its content was replaced; a
        // new instance → the document reconnected.
        ended = {
          status: "stopped",
          reason:
            live === null ? "aborted" : live.doc === ydoc ? "content-replaced" : "reconnected",
        };
        if (live?.doc === ydoc) {
          // #2070: the SAME instance, so the content was replaced under the
          // turn (force-open, a source-view commit, a reload from disk). Unlike
          // the swap arm below this one does test the token: a superseded run
          // would tell the user about a reload the newer run already started
          // from, and the arm is not dead code with the test in place, because
          // `stillOwner()` fails here on the generation, not the token.
          if (current?.token === token) {
            pushNotification({
              id: generateMessageId(),
              type: "general-error",
              severity: "warning",
              message:
                "The local model stopped: this document's content was replaced mid-turn (reloaded or edited in source view), so it stopped early — any comments it already added were carried over where their text survived, but its reply was not delivered. Ask again to continue.",
              documentId: req.docName,
              timestamp: Date.now(),
            });
          }
        } else if (live) {
          pushNotification({
            id: generateMessageId(),
            type: "general-error",
            severity: "warning",
            // Narrower than "the rest of its work was discarded" on purpose:
            // `provider.ts` merges the old state into the fresh doc before
            // destroying it, so annotations from turns that completed before
            // the swap survive — only the terminal reply is dropped.
            message:
              "The local model stopped: this document reconnected mid-turn, so it stopped early — any comments it already added are still there, but its reply was not delivered. Ask again to continue.",
            documentId: req.docName,
            timestamp: Date.now(),
          });
        }
      } else if (!stillOwner()) {
        // Dropped silently, as before: superseded, aborted or closed — or its
        // content replaced after the loop's last check.
        ended = {
          status: "stopped",
          reason:
            current?.token !== token || abort.signal.aborted || !docUnchanged()
              ? "aborted"
              : "content-replaced",
        };
      } else {
        const exit = result.metrics.exit;
        ended = endedFor(exit);
        if (exit === "clean") {
          sink.flushFinal();
          // Replied only if the flush really left a reply row. A flush the
          // licence refused aborted the run instead (`makeSink`): "aborted".
          ended =
            sink.replyId() !== null
              ? { status: "replied" }
              : abort.signal.aborted
                ? { status: "stopped", reason: "aborted" }
                : { status: "stopped", reason: "no-reply" };
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
        } else if (exit === "editing_off") {
          // The model called a writing tool in a run that may not write, was
          // told so, and then had one turn with no tools to answer in text —
          // and said nothing. Not a step limit: say what actually happened.
          // (When it did answer, the exit is `clean`.) `info`, so it expires.
          // Solo is named when Solo was the cause (#1123): the setting alone
          // would have allowed it.
          sink.flushFinal();
          if (refusedBy === "solo" || refusedBy === "mode-unknown") {
            ended = { status: "stopped", reason: refusedBy };
          }
          pushNotification({
            id: generateMessageId(),
            type: "general-error",
            severity: "info",
            message:
              refusedBy === "solo"
                ? "The local model stopped without replying: it tried to comment on or change the document, which local models do not do in Solo mode. Ask again for an answer in chat."
                : refusedBy === "mode-unknown"
                  ? "The local model stopped without replying: it tried to comment on or change the document, which local models do not do while Tandem cannot tell whether it is in Solo or Tandem mode. Ask again for an answer in chat."
                  : "The local model stopped without replying: it tried to comment on or change the document, which local models were not allowed to do for that reply. Ask again for an answer in chat.",
            documentId: req.docName,
            timestamp: Date.now(),
          });
        } else if (exit === "timeout") {
          // Deliberately its own branch, not folded into the budget message
          // above (#1295 L6). A wall-clock exit happens with turns to spare, so
          // "reached its step limit" would be false and would send the user to
          // raise maxTurns for what is really a slow or stalling endpoint.
          sink.flushFinal();
          pushNotification({
            id: generateMessageId(),
            type: "general-error",
            severity: "warning",
            message: "The local model stopped before finishing (it ran out of time).",
            documentId: req.docName,
            timestamp: Date.now(),
          });
        } else if (exit === "error") {
          // Commit what did arrive before the fault (#1292). The runaway case
          // this cap exists for — a quantized model in a repetition loop —
          // trips the WIRE cap inside readStream, which throws, so the run
          // lands here rather than on the sink's own truncation path. Without
          // this flush the user is left with a bubble frozen at the last 80-char
          // flush boundary and only a generic notification to explain it.
          // no-ops on an empty buffer, so a fault before any content still
          // mints nothing.
          sink.flushFinal();
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
      // After the fold, so the state never says "replied" before the reply
      // row holds its final text. A successor run awaits this promise before
      // it starts, so its own "running" can never be overwritten by this.
      const final = ended ?? { status: "stopped" as const, reason: "error" as const };
      const replyId = sink.replyId();
      writeLocalRun(req.replyTo, { ...final, ...(replyId ? { replyId } : {}) });
    }
  }

  /** The run state for a loop exit, while this run still owns the slot.
   *  (`clean` is refined by the caller once it knows whether a reply landed.) */
  function endedFor(exit: LoopResult["metrics"]["exit"]): {
    status: "replied" | "stopped";
    reason?: LocalRunStopReason;
  } {
    switch (exit) {
      case "clean":
        return { status: "stopped", reason: "no-reply" };
      case "max_turns":
      case "max_tool_calls":
        return { status: "stopped", reason: "step-limit" };
      case "editing_off":
        return { status: "stopped", reason: "editing-off" };
      case "timeout":
        return { status: "stopped", reason: "timeout" };
      case "error":
        return { status: "stopped", reason: "error" };
      default:
        return { status: "stopped", reason: "aborted" };
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
        req.threw = true;
      } finally {
        // Claimed but never started (superseded, switched to Claude, or its
        // document changed while it waited): the editor is still told it
        // ended, and why (R3.4). Not for a run that posted a notice instead.
        if (!req.started && !req.noticed) {
          try {
            writeLocalRun(req.replyTo, {
              status: "stopped",
              reason: req.threw ? "error" : "aborted",
            });
          } catch (err) {
            console.error("[local-model] could not record the run state", err);
          }
        }
        if (current?.token === token) current = null;
      }
    })();
  }

  function logRefusal(refusal: AiRefusal): void {
    if (loggedRefusal === refusal.kind) return;
    loggedRefusal = refusal.kind;
    console.error(
      `[local-model] ${
        refusal.kind === "unlicensed" ? AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE : refusal.message
      }`,
    );
  }

  /**
   * Tell the user, once per broken state, why their local model did not answer
   * (#1123 R1.3 to R1.5). Through `pushNotification` only — the browser's
   * notify stream. Never chat and never the event queue: either would be a new
   * AI surface (CLAUDE.md Critical Rule 9).
   *
   * "Once" is this in-memory latch, because the client cannot do it: its
   * `dedupKey` re-pops the toast with a count, and its notify stream drops an
   * `id` it has already seen — hence a fresh id each time, and no `dedupKey`.
   * The latch does not survive a restart, and it is set whether or not a
   * browser was listening (`pushNotification` has no replay).
   */
  function noticeUnusable(state: LocalModelUnusable): void {
    if (noticedStateKey === state.stateKey) return;
    noticedStateKey = state.stateKey;
    // The breadcrumb names the entry id and reject code, never the endpoint.
    console.error(`[local-model] not answering: ${state.detail}`);
    pushNotification({
      id: generateMessageId(),
      type: "general-error",
      severity: "warning",
      message: UNUSABLE_NOTICE[state.reason],
      timestamp: Date.now(),
    });
  }

  /**
   * A change to WHICH model answers, or WHERE it points (#2404). Compares the
   * entry, its Endpoint and its model id — not its display name, so a rename is
   * not a different model.
   *
   * A write from Tandem's own window is the user's own: no warning, and the
   * record is set at once — but only when that write changed which model
   * answers, or added, edited or defaulted the answering entry. A write that
   * left the answering model alone records nothing and withdraws nothing, so
   * the user's unrelated edit can never bless a model some other writer put
   * there. The one thing their own change can do without their noticing is
   * make a different, untouched model start answering; that raises one info
   * notice (never for the one-time reconcile).
   *
   * Any other write is announced: live through `pushNotification`, and
   * registered for replay to a browser that connects later in this run. Never
   * chat, never the event queue.
   */
  function noticeAnsweringChange(change?: ModelsFileChange): void {
    const now = deps.answering?.() ?? null;
    if (now === null) {
      // No model answers now. Forget the last one, so that a model answering
      // again is compared afresh even if it is the very same entry.
      if (lastAnswering !== null) deps.announced?.none();
      lastAnswering = null;
      return;
    }
    const before = lastAnswering;
    lastAnswering = now;
    const identityChanged =
      before === null ||
      before.entryId !== now.entryId ||
      before.endpoint !== now.endpoint ||
      before.modelId !== now.modelId;
    if (change?.source === "own-window") {
      const touched = entryTouchedByWrite(change, now.entryId);
      if (identityChanged || touched) deps.announced?.setByUser?.(answeringFingerprint(now));
      else deps.announced?.retry?.();
      if (identityChanged && !touched && !change.reconcile) {
        pushNotification({
          id: generateMessageId(),
          type: "general-error",
          severity: "info",
          message: answeringSwitchedNotice(now),
          timestamp: Date.now(),
        });
      }
      return;
    }
    if (!identityChanged) {
      deps.announced?.retry?.();
      return;
    }
    announceAnswering(now);
  }

  function announceAnswering(now: AnsweringLocalModel): void {
    const message = answeringChangedNotice(now);
    if (deps.announced) {
      deps.announced.announce(ANSWERING_CHANGED_NOTICE_KEY, message, answeringFingerprint(now));
      return;
    }
    const notice = {
      id: generateMessageId(),
      type: "general-error" as const,
      severity: "warning" as const,
      message,
      dedupKey: ANSWERING_CHANGED_NOTICE_KEY,
      timestamp: Date.now(),
    };
    addStartupNotice(notice);
    pushNotification(notice);
  }

  /**
   * The saved registry changed. Forget the latched state unless it is still
   * exactly the state the user was told about — so a model that is fixed and
   * then broken again is reported again even when no chat arrived while it was
   * fixed, and Solo or licence-refused chats cannot keep a stale latch alive.
   */
  function onModelsChanged(change?: ModelsFileChange): void {
    noticeAnsweringChange(change);
    if (noticedStateKey === null) return;
    const now = deps.resolveConfig() ? null : (deps.diagnose?.() ?? null);
    if (now?.stateKey !== noticedStateKey) noticedStateKey = null;
  }

  /**
   * Post one chat notice for `messageId` (#1123 R3.2), off the synchronous
   * emit path. Like any new chat it supersedes a run in flight: the run is
   * aborted (its exit is the silent `aborted`). A notice for a document that is
   * not open carries no `documentId`. A licence that lapsed since `onEvent`
   * checked it refuses the write: logged once, nothing posted.
   */
  function postNotice(
    kind: ChatNoticeKind,
    messageId: string,
    documentId?: string,
    text: string = CHAT_NOTICE_TEXT[kind],
  ): void {
    queueMicrotask(() => {
      if (current) current.abort.abort();
      // The switch may have moved to Claude since the chat arrived.
      if (answerer() !== "local") return;
      const appended = appendClaudeChatMessage(text, {
        replyTo: messageId,
        ...(documentId ? { documentId } : {}),
        chatNotice: kind,
      });
      if (!appended.ok) logRefusal(appended.refusal);
    });
  }

  /** The switch moved (#1123 R2.1). To Claude: stop a run in flight, by abort
   *  — its exit is the silent `aborted`, never `isDocCurrent`'s notice. */
  function onAnswererChanged(now: ChatAnswerer): void {
    if (now !== "local" && current) current.abort.abort();
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
    // Who answers chat (#1123): with Claude chosen the local model runs
    // nothing and posts nothing — no notice and no unusable toast. In Solo it
    // answers too (Bryan, 2026-11-12), in the chat tier (`executeRun`).
    if (answerer() !== "local") return;
    // Licence admission (#1521), per chat, BEFORE anything else is decided: no
    // turn, no notice, no chat write, one stderr line per refused state. An
    // unlicensed install is told about the licence by the editor's AI-off
    // notice, not about a model it could not use anyway.
    const refusal = decideRefusal();
    if (refusal) {
      logRefusal(refusal);
      return;
    }
    loggedRefusal = null;
    const messageId = event.payload.messageId;
    // No document open, or one that is no longer open: the no-document notice.
    // It wins over "no local model can answer" — opening a document is the
    // first thing either remedy needs.
    const docName = event.documentId ?? getActiveDocId();
    if (!docName || !requireDocument(docName)) {
      if (messageId) postNotice("no-document", messageId);
      return;
    }
    // Resolved per chat event, from the registry cache `POST /api/models`
    // replaces on every successful write — so a model saved a second ago is
    // used by this chat, with no restart.
    const config = deps.resolveConfig();
    if (!config) {
      // Nothing resolves: none saved, the chosen default deleted, disabled or
      // a cloud model, or an unusable state. The switch stays where the user
      // put it (decision 5), and every chat is told. An unusable state also
      // keeps its once-per-state toast.
      const broken = deps.diagnose?.() ?? null;
      if (broken) noticeUnusable(broken);
      else noticedStateKey = null;
      if (messageId) {
        postNotice(
          "no-local-model",
          messageId,
          docName,
          broken ? CHAT_NOTICE_UNUSABLE_TEXT[broken.reason] : undefined,
        );
      }
      return;
    }
    noticedStateKey = null;

    // Hand off OFF the synchronous emit path (the callback runs inside the
    // originating browser-origin txn; a sync write here would be mis-tagged).
    queueMicrotask(() =>
      run({
        config,
        docName,
        task,
        selection: event.payload.selection,
        replyTo: messageId,
      }),
    );
  }

  // Register the subscriber. Split from start() so tests can exercise the real
  // subscribe/unsubscribe pairing without the compile-time dark gate (which
  // always early-returns in test builds). Nothing is resolved here: the config
  // is read per chat event.
  function wire(): void {
    // The start-up check (#2404). The model found at start-up is NOT assumed
    // to be what the user last left: unless the record names exactly this
    // model — because the user chose it in Tandem's own window, or was told —
    // the start-up notice is raised. Otherwise a file changed underneath
    // would start as the silent baseline. The one exception is the first
    // start with the flag on, which takes what it finds as the baseline.
    lastAnswering = deps.answering?.() ?? null;
    if (lastAnswering === null) {
      // Nothing answers at start-up: forget which model the user was told
      // about. The record can outlive the model it names (the write that
      // cleared it failed, or `models.json` changed while the server was
      // down), and a stale "told" would let that same model be re-enabled
      // with no window open and then start, after one more restart, as the
      // silent baseline.
      deps.announced?.none();
    } else if (
      deps.announced &&
      !deps.announced.wasAnnounced(answeringFingerprint(lastAnswering))
    ) {
      const fingerprint = answeringFingerprint(lastAnswering);
      if (deps.announced.firstLitStart?.()) {
        deps.announced.baseline?.(fingerprint);
        deps.announced.adopted?.(baselineAdoptedNotice(lastAnswering));
      } else if (deps.announced.startupMismatch) deps.announced.startupMismatch(fingerprint);
      else announceAnswering(lastAnswering);
    } else if (deps.announced?.adoptionPending?.(answeringFingerprint(lastAnswering))) {
      // A later start: the baseline's model still answers and no window of
      // Tandem's was ever sent the notice that names it. Say it again.
      deps.announced.adopted?.(baselineAdoptedNotice(lastAnswering));
    }
    deps.announced?.finishStart?.();
    stopWatchingModels = deps.onModelsChanged?.(onModelsChanged) ?? null;
    stopWatchingAnswerer = deps.onChatAnswererChanged?.(onAnswererChanged) ?? null;
    subscriberCb = onEvent;
    // "internal" is passed EXPLICITLY, not left to the default. Two correctness
    // properties now hang on this subscriber not being external:
    //   1. `alreadyPushed` — an in-process listener must not make the server
    //      claim an event was handed to a consumer (#1242).
    //   2. The WS-A2 Solo forwarder gate — external consumers are held in Solo,
    //      but this loop needs `document:closed` / `document:switched` to abort
    //      in-flight runs, so it must keep receiving them.
    // Relying on a silent default is a poor place to hang a privacy gate.
    deps.subscribe(subscriberCb, "internal");
  }

  function start(): void {
    if (!BYO_MODELS_ENABLED) return; // DARK: never subscribe, never read config
    wire();
  }

  async function stop(): Promise<void> {
    stopWatchingModels?.();
    stopWatchingModels = null;
    stopWatchingAnswerer?.();
    stopWatchingAnswerer = null;
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
    /** test seam: subscribe without the BYO flag gate. */
    __startForTests: wire,
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
