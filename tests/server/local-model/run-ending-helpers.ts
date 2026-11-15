/**
 * Shared driver for the part C tests (#1123): the SHIPPED collaborator, the
 * real `runLocalModelTurn` / `runLoop` and client, and a `fetch` whose stream
 * each test drives by hand (`manualStream`) under fake timers — so a flush can
 * land mid-turn, which `scriptedFetch` (every frame enqueued up front) never
 * allows (brief R6).
 */
import { vi } from "vitest";
import { getOpenDocs } from "../../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry-testing.js";
import { resetForTesting as resetQueue } from "../../../src/server/events/queue.js";
import {
  type CollaboratorDeps,
  createLocalModelCollaborator,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import { runLocalModelTurn } from "../../../src/server/local-model/index.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import { clearStartupNotices } from "../../../src/server/startup-notices.js";
import { getOrCreateDocument, removeDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_CHAT_STREAM,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import { withInternal } from "../../../src/shared/origins.js";
import type { ChatMessage } from "../../../src/shared/types.js";
import { manualStream } from "./harness/helpers.js";

export const CONFIG: LocalModelConfig = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
};

/** Past `STREAM_FLUSH_MS` (120). */
export const PAST_FLUSH_MS = 200;
/** Past `STREAM_FLUSH_CHARS` (80). */
export const PAST_FLUSH_CHARS = 90;

export type Stream = ReturnType<typeof manualStream>;
export interface Request {
  stream: Stream;
  body: Record<string, unknown>;
  bodyText: string;
}

/**
 * A `fetch` that gives every chat request its own hand-driven stream. `next()`
 * resolves with the next request as it arrives.
 */
export function streamFetch() {
  const arrived: Request[] = [];
  const waiters: ((r: Request) => void)[] = [];
  let taken = 0;
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const stream = manualStream();
    const res = stream.response(init);
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const req: Request = { stream, body: JSON.parse(bodyText), bodyText };
    arrived.push(req);
    const w = waiters.shift();
    if (w) w(arrived[taken++]);
    return res;
  };
  vi.stubGlobal("fetch", impl);
  return {
    requests: arrived,
    /** The next request, once it has arrived (advances fake timers while waiting). */
    async next(): Promise<Request> {
      if (taken < arrived.length) return arrived[taken++];
      const p = new Promise<Request>((r) => waiters.push(r));
      // Microtasks first: a turn's next request needs no timer, and a test may
      // depend on a pending timer (the cap's) not firing yet.
      for (let i = 0; i < 5000 && taken >= arrived.length; i++) await Promise.resolve();
      for (let i = 0; i < 200 && taken >= arrived.length; i++) {
        await vi.advanceTimersByTimeAsync(1);
      }
      return p;
    },
  };
}

export function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}
export function streamMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT_STREAM);
}
export function rows(): ChatMessage[] {
  return [...chatMap().values()] as ChatMessage[];
}
export function row(id: string): ChatMessage | undefined {
  return chatMap().get(id) as ChatMessage | undefined;
}
/** The local model's reply rows for `messageId` (notices excluded). */
export function replyRows(messageId: string): ChatMessage[] {
  return rows().filter(
    (m) => m.author === "claude" && m.replyTo === messageId && m.chatNotice === undefined,
  );
}
export function noticeRows(messageId: string): ChatMessage[] {
  return rows().filter((m) => m.replyTo === messageId && m.chatNotice !== undefined);
}

/**
 * What the editor can show for the run's reply row right now: the sidecar's
 * text while its entry exists, else the row's own text. "" when no row.
 */
export function shownNow(messageId: string): string {
  const r = replyRows(messageId);
  if (r.length === 0) return "";
  const side = streamMap().get(r[0].id);
  return side !== undefined ? String(side) : r[0].text;
}

export function toasts(docId: string): { severity: string; message: string }[] {
  return getBuffer()
    .filter((n) => n.documentId === docId)
    .map((n) => ({ severity: n.severity ?? "", message: n.message }));
}

export function setMode(mode: "solo" | "tandem" | null) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    const m = ctrl.getMap(Y_MAP_USER_AWARENESS);
    if (mode === null) m.delete(Y_MAP_MODE);
    else m.set(Y_MAP_MODE, mode);
  });
}

export function setupDoc(id: string, text = "# Title\n\nThe body says hello.") {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

/** Replace a room's Y.Doc the way Hocuspocus's `onLoadDocument` does (#1657). */
export function swapDoc(id: string, text = "# Title\n\nThe body says hello.") {
  const old = getOrCreateDocument(id);
  removeDocument(id);
  const fresh = getOrCreateDocument(id);
  populateYDoc(fresh, text);
  old.destroy();
  return fresh;
}

/** The user's chat row plus its `chat:message` event. */
export function userChat(id: string, documentId: string, text = "What does the body say?") {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  const msg: ChatMessage = {
    id,
    author: "user",
    text,
    timestamp: Date.now(),
    read: false,
    documentId,
  };
  withInternal(ctrl, () => chatMap().set(id, msg));
  const event: TandemEvent = {
    id: `evt_${id}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId,
    payload: { messageId: id, text, replyTo: null, anchor: null },
  };
  return event;
}

export function resetWorld() {
  resetQueue();
  resetNotifications();
  clearStartupNotices();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    ctrl.getMap(Y_MAP_CHAT).clear();
    ctrl.getMap(Y_MAP_CHAT_STREAM).clear();
  });
  setMode("tandem");
}

export function collaborator(over: Partial<CollaboratorDeps> = {}) {
  const deps: CollaboratorDeps = {
    runTurn: runLocalModelTurn,
    resolveConfig: () => CONFIG,
    subscribe: () => {},
    unsubscribe: () => {},
    aiRefusal: () => null,
    chatAnswerer: () => "local",
    editingState: () => ({ enabled: false, offEpoch: 0 }),
    ...over,
  };
  return createLocalModelCollaborator(deps);
}

/** Let the run's microtasks and any due timers run. */
export async function settle(collab: ReturnType<typeof collaborator>) {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  await collab.__awaitCurrent();
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

/**
 * Rows, `localRun` and toasts with generated ids and timestamps normalised
 * (R6), for comparing an ending with master's.
 */
export function snapshot(docId: string) {
  const ids = new Map<string, string>();
  const norm = (id: string | undefined) => {
    if (id === undefined) return undefined;
    if (id.startsWith("u")) return id;
    if (!ids.has(id)) ids.set(id, `id${ids.size}`);
    return ids.get(id);
  };
  const all = rows().sort((a, b) => a.timestamp - b.timestamp || a.text.localeCompare(b.text));
  const out = all.map((m) => {
    const copy: Record<string, unknown> = { ...m, id: norm(m.id), timestamp: 0 };
    if (m.localRun) {
      copy.localRun = {
        ...m.localRun,
        generation: "G",
        ...(m.localRun.replyId ? { replyId: norm(m.localRun.replyId) } : {}),
      };
    }
    return copy;
  });
  return { rows: out, sidecars: streamMap().size, toasts: toasts(docId) };
}

/** Run pending microtasks only — no timer fires. */
export async function microtasks(n = 200) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
