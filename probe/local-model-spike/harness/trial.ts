/**
 * One trial: one chat message, handled the way the product handles it.
 *
 * The harness owns no loop, prompt, tool list or chat request. A trial builds a
 * document, hands a `chat:message` event to the SHIPPED collaborator
 * (`createLocalModelCollaborator`), and reads back what the user's chat row
 * holds afterwards. Whether the document is inlined, how a selection is worded,
 * the temperature, the transport, streaming, the response cap, the per-turn
 * timeout, the run deadline and the turn and tool-call budgets are all decided
 * by product code on the way through; nothing here restates one. A change under
 * `src/server/local-model/` therefore changes what is measured with no edit to
 * this file.
 *
 * What is substituted, and why each is safe for a measurement:
 *  - config resolution: the model comes from the command line, not `models.json`
 *    (the resolver only picks WHICH saved model answers);
 *  - the editing setting: the tier comes from the command line, not
 *    `local-model-settings.json`; the collaborator still reads it through its
 *    own `editingState` seam, per run and per tool call;
 *  - the licence decision: injected as "admitted" (the gate ships dark, and a
 *    refused run produces no reply to measure);
 *  - the unusable-model notice and the "answering model changed" notice: never
 *    reached, their seams are injected inert so nothing is written to app data;
 *  - the event queue: the event is handed to `onEvent` directly, so a selection
 *    is given in the event payload instead of through the queue's selection
 *    buffer. The collaborator reads only `payload.selection.selectedText`.
 * Solo/Tandem is NOT substituted: the collaborator's own `readLiveMode()` runs
 * against the in-process control document, which the trial sets to Tandem.
 */
import type * as Y from "yjs";

import { addDoc, removeDoc } from "../../../src/server/documents/registry-testing.js";
import { loadMarkdown } from "../../../src/server/file-io/markdown.js";
import {
  type CollaboratorDeps,
  createLocalModelCollaborator,
} from "../../../src/server/local-model/collaborator.js";
import {
  type LocalModelConfig,
  type LoopResult,
  type RunTurnOpts,
  runLocalModelTurn,
} from "../../../src/server/local-model/index.js";
import { extractText } from "../../../src/server/mcp/document-model.js";
import { findOccurrence } from "../../../src/server/mcp/navigation.js";
import { subscribe as subscribeNotifications } from "../../../src/server/notifications.js";
import { getOrCreateDocument, removeDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import { withInternal } from "../../../src/shared/origins.js";
import { type FetchTap, installFetchTap, type TapRecord } from "./fetch-tap.js";

export type Tier = "chat" | "editing";

export interface TrialInput {
  /** The document, as markdown. */
  markdown: string;
  /** The user's chat message. */
  prompt: string;
  /** Text the user has selected, verbatim from the document, if any. */
  selectedText?: string;
  tier: Tier;
  config: LocalModelConfig;
}

/** One model turn as the user's chat saw it stream. */
export interface TurnText {
  turn: number;
  /** Everything streamed as content during this turn. */
  text: string;
  /** The turn ended in tool calls (so its text was a preamble). Null when the
   *  turn never reached its end (a timeout or an error cut it). */
  hadToolCalls: boolean | null;
}

export interface WrittenAnnotation {
  id: string;
  kind: "comment" | "replacement";
  content: string;
  suggestedText?: string;
  range: { from: number; to: number } | null;
  /** The document text under the stored range, for the reader. */
  anchoredText: string;
}

export interface WrittenReply {
  id: string;
  annotationId: string;
  text: string;
}

/** What actually landed in the document during the run: the measure every
 *  claim in a reply is judged against. */
export interface WriteLog {
  annotations: WrittenAnnotation[];
  replies: WrittenReply[];
}

export interface TrialObservation {
  /** The text the user's chat row holds once the run is over ("" when there is no row). */
  reply: string;
  /** How many chat rows the run produced (0 or 1). */
  replyRows: number;
  turns: TurnText[];
  /** The shipped loop's own result; null when the collaborator never ran a turn. */
  loop: Pick<LoopResult, "metrics" | "steps" | "finalContent"> | null;
  /** What the collaborator handed the shipped turn runner (functions omitted). */
  turnOpts: {
    keys: string[];
    task: string;
    includeFullText: boolean | undefined;
    maxResponseBytes: number | undefined;
    temperature: number | undefined;
    timeoutMs: number | undefined;
    maxTurns: number | undefined;
    maxToolCalls: number | undefined;
    hasHistory: boolean;
  } | null;
  /** Each tool result the product handed back to the model, in order. */
  toolResults: { name: string; content: string }[];
  /** In-app notices the run raised (the user sees these beside the chat). */
  notices: { severity: string; message: string }[];
  writes: WriteLog;
  /** The document's flat text (what quotes are checked against). */
  documentText: string;
  fetches: TapRecord[];
  timeToFirstTextMs: number | null;
  totalMs: number;
}

/**
 * The longest selection the product's editor sends whole. Beyond it the client
 * cuts the text (`src/client/editor/extensions/awareness.ts`), so a longer
 * selection here would be text the product never gives a model. Restated
 * because the client module cannot be imported in Node; pinned against the
 * client's source by `tests/server/local-model/harness/scenarios.test.ts`.
 */
export const CLIENT_SELECTION_MAX = 200;

let trialCounter = 0;

function setTandemMode(): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem"));
}

function readWrites(ydoc: Y.Doc, documentText: string): WriteLog {
  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON() as Record<
    string,
    { content?: string; suggestedText?: string; range?: { from: number; to: number } }
  >;
  const annotations: WrittenAnnotation[] = Object.entries(annMap).map(([id, v]) => ({
    id,
    kind: v.suggestedText !== undefined ? "replacement" : "comment",
    content: v.content ?? "",
    ...(v.suggestedText !== undefined ? { suggestedText: v.suggestedText } : {}),
    range: v.range ?? null,
    anchoredText: v.range ? documentText.slice(v.range.from, v.range.to) : "",
  }));
  const replyMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON() as Record<
    string,
    { id?: string; annotationId?: string; text?: string }
  >;
  const replies: WrittenReply[] = Object.entries(replyMap).map(([key, v]) => ({
    id: v.id ?? key,
    annotationId: v.annotationId ?? "",
    text: v.text ?? "",
  }));
  return { annotations, replies };
}

function chatRowsFor(messageId: string): string[] {
  const rows = [...getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).values()] as {
    author?: string;
    replyTo?: string;
    text?: string;
  }[];
  return rows
    .filter((r) => r.author === "claude" && r.replyTo === messageId)
    .map((r) => r.text ?? "");
}

/**
 * The collaborator's dependencies for a trial. EVERY seam is injected: several
 * defaults read or write records under the app-data directory.
 */
export function trialDeps(
  input: Pick<TrialInput, "tier" | "config">,
  runTurn: CollaboratorDeps["runTurn"],
): Required<CollaboratorDeps> {
  return {
    runTurn,
    resolveConfig: () => input.config,
    subscribe: () => {},
    unsubscribe: () => {},
    aiRefusal: () => null,
    diagnose: () => null,
    editingState: () => ({ enabled: input.tier === "editing", offEpoch: 0 }),
    onModelsChanged: () => () => {},
    answering: () => null,
    announced: { wasAnnounced: () => true, announce: () => {}, none: () => {} },
  };
}

export async function runTrial(input: TrialInput): Promise<TrialObservation> {
  trialCounter += 1;
  const docId = `harness-trial-${process.pid}-${trialCounter}`;
  const messageId = `harness-msg-${process.pid}-${trialCounter}`;

  const ydoc = getOrCreateDocument(docId);
  loadMarkdown(ydoc, input.markdown);
  const documentText = extractText(ydoc);
  if (
    ydoc.getMap(Y_MAP_ANNOTATIONS).size !== 0 ||
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size !== 0
  ) {
    throw new Error("trial document is not empty of annotations before the message");
  }
  addDoc(docId, {
    id: docId,
    filePath: `harness://${docId}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  setTandemMode();

  const turns: TurnText[] = [];
  let currentText = "";
  let turnIndex = 0;
  let firstTextAt: number | null = null;
  const seen: {
    loop: TrialObservation["loop"];
    turnOpts: TrialObservation["turnOpts"];
    toolResults: TrialObservation["toolResults"];
  } = { loop: null, turnOpts: null, toolResults: [] };

  const notices: TrialObservation["notices"] = [];
  const stopNotices = subscribeNotifications((n) => {
    if (n.documentId === undefined || n.documentId === docId) {
      notices.push({ severity: n.severity ?? "", message: n.message });
    }
  });

  // The injected turn runner: the SHIPPED one, with the two streaming callbacks
  // teed so each turn's text is kept. Every other option passes through as the
  // collaborator set it.
  const runTurn = async (opts: RunTurnOpts): Promise<LoopResult> => {
    seen.turnOpts = {
      keys: Object.keys(opts).sort(),
      task: opts.task,
      includeFullText: opts.includeFullText,
      maxResponseBytes: opts.maxResponseBytes,
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      maxTurns: opts.maxTurns,
      maxToolCalls: opts.maxToolCalls,
      hasHistory: opts.history !== undefined,
    };
    const result = await runLocalModelTurn({
      ...opts,
      onContentDelta: (delta) => {
        if (firstTextAt === null && delta.length > 0) firstTextAt = Date.now();
        currentText += delta;
        opts.onContentDelta?.(delta);
      },
      onTurnEnd: (info) => {
        turnIndex += 1;
        turns.push({ turn: turnIndex, text: currentText, hadToolCalls: info.hadToolCalls });
        currentText = "";
        opts.onTurnEnd?.(info);
      },
    });
    // A turn cut before its end (timeout, error, abort) never reports a turn
    // end, but the user may have watched its text stream.
    if (currentText.length > 0) {
      turnIndex += 1;
      turns.push({ turn: turnIndex, text: currentText, hadToolCalls: null });
      currentText = "";
    }
    seen.loop = {
      metrics: result.metrics,
      steps: result.steps,
      finalContent: result.finalContent,
    };
    seen.toolResults = result.messages
      .filter((m) => m.role === "tool")
      .map((m) => ({ name: m.tool_name ?? "", content: m.content }));
    return result;
  };

  const collab = createLocalModelCollaborator(trialDeps(input, runTurn));
  const tap: FetchTap = installFetchTap();
  const started = Date.now();

  let selection: { from: number; to: number; selectedText: string } | undefined;
  if (input.selectedText !== undefined) {
    if (input.selectedText.length > CLIENT_SELECTION_MAX || input.selectedText.includes("\n")) {
      throw new Error(
        `trial selection is not one the editor can send (over ${CLIENT_SELECTION_MAX} characters, or spans blocks)`,
      );
    }
    const hit = findOccurrence(documentText, input.selectedText, 1);
    if ("error" in hit) {
      throw new Error(`trial selection is not in the document: ${JSON.stringify(input.selectedText)}`);
    }
    selection = { from: hit.from, to: hit.to, selectedText: input.selectedText };
  }

  const event: TandemEvent = {
    id: `harness-evt-${process.pid}-${trialCounter}`,
    type: "chat:message",
    timestamp: started,
    documentId: docId,
    payload: {
      messageId,
      text: input.prompt,
      replyTo: null,
      anchor: null,
      ...(selection ? { selection } : {}),
    },
  };

  try {
    collab.onEvent(event);
    // `onEvent` hands the run off on a microtask; let it claim the slot first.
    await Promise.resolve();
    await collab.__awaitCurrent();
    await collab.stop();
    await tap.settle();

    const rows = chatRowsFor(messageId);
    return {
      reply: rows[0] ?? "",
      replyRows: rows.length,
      turns,
      loop: seen.loop,
      turnOpts: seen.turnOpts,
      toolResults: seen.toolResults,
      notices,
      writes: readWrites(ydoc, documentText),
      documentText,
      fetches: tap.records,
      timeToFirstTextMs: firstTextAt === null ? null : firstTextAt - started,
      totalMs: Date.now() - started,
    };
  } finally {
    tap.restore();
    stopNotices();
    removeDoc(docId);
    removeDocument(docId);
    ydoc.destroy();
  }
}
