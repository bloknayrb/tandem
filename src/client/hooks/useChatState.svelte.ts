import * as Y from "yjs";
import {
  DEFAULT_MCP_PORT,
  Y_MAP_CHAT,
  Y_MAP_CHAT_DOCUMENT_NAMES,
  Y_MAP_CHAT_SEEN,
  Y_MAP_CHAT_SEEN_INITIALIZED,
} from "../../shared/constants";
import { API_CHAT } from "../../shared/api-paths";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { generateMessageId } from "../../shared/utils";

const MAX_SEEN_MESSAGE_IDS = 400;

export interface ChatState {
  readonly messages: ChatMessage[];
  readonly documentFileNames: ReadonlyMap<string, string>;
  readonly initialSyncComplete: boolean;
  readonly unreadCount: number;
  send(text: string, documentId?: string, anchor?: CapturedAnchor | null): boolean;
  acknowledgeVisible(): void;
  clear(): Promise<number>;
}

export function createChatState(options: {
  getCtrlYdoc: () => Y.Doc | null;
  getInitialSyncComplete: () => boolean;
  getInitialClaudeMessageIds: () => readonly string[];
  getOpenDocuments: () => readonly { id: string; fileName: string }[];
  getVisible: () => boolean;
}): ChatState {
  let messages = $state<ChatMessage[]>([]);
  let seenIds = $state(new Set<string>());
  let documentFileNames = $state(new Map<string, string>());
  const unreadCount = $derived(
    options.getInitialSyncComplete()
      ? messages.filter((message) => message.author === "claude" && !seenIds.has(message.id)).length
      : 0,
  );

  function refresh(doc: Y.Doc): void {
    const next: ChatMessage[] = [];
    doc.getMap(Y_MAP_CHAT).forEach((value) => next.push(value as ChatMessage));
    next.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    messages = next;
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    seenIds = new Set(
      Array.from(seen.entries())
        .filter(([id, value]) => id !== Y_MAP_CHAT_SEEN_INITIALIZED && value === true)
        .map(([id]) => id),
    );
    const names = doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES);
    documentFileNames = new Map(
      Array.from(names.entries()).flatMap(([id, value]) => {
        const fileName = safeFileName(value);
        return fileName ? [[id, fileName] as const] : [];
      }),
    );
  }

  function safeFileName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const fileName = value.split(/[\\/]/).pop()?.trim();
    return fileName ? fileName : null;
  }

  function pruneSeen(doc: Y.Doc): void {
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    const keep = new Set(
      messages
        .filter((message) => message.author === "claude")
        .slice(-MAX_SEEN_MESSAGE_IDS)
        .map((message) => message.id),
    );
    for (const key of seen.keys()) {
      if (key !== Y_MAP_CHAT_SEEN_INITIALIZED && !keep.has(key)) seen.delete(key);
    }
  }

  function acknowledgeIds(doc: Y.Doc, ids: readonly string[], baseline = false): void {
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    doc.transact(() => {
      if (baseline && seen.get(Y_MAP_CHAT_SEEN_INITIALIZED) !== true) {
        seen.set(Y_MAP_CHAT_SEEN_INITIALIZED, true);
      }
      for (const id of ids) if (seen.get(id) !== true) seen.set(id, true);
      pruneSeen(doc);
    });
  }

  function acknowledgeVisibleMessages(doc: Y.Doc): void {
    acknowledgeIds(
      doc,
      messages.filter((message) => message.author === "claude").map((message) => message.id),
    );
  }

  $effect(() => {
    const doc = options.getCtrlYdoc();
    if (!doc) {
      messages = [];
      seenIds = new Set();
      documentFileNames = new Map();
      return;
    }
    const chat = doc.getMap(Y_MAP_CHAT);
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    const names = doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES);
    const observer = () => refresh(doc);
    chat.observe(observer);
    seen.observe(observer);
    names.observe(observer);
    observer();
    return () => {
      chat.unobserve(observer);
      seen.unobserve(observer);
      names.unobserve(observer);
    };
  });

  // Do not baseline an empty pre-sync document. The provider's first synced
  // boundary establishes the authoritative history for first-rollout marking.
  $effect(() => {
    const doc = options.getCtrlYdoc();
    const synced = options.getInitialSyncComplete();
    const initialClaudeIds = options.getInitialClaudeMessageIds();
    void messages;
    if (!doc || !synced) return;
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    if (seen.get(Y_MAP_CHAT_SEEN_INITIALIZED) !== true) {
      acknowledgeIds(doc, initialClaudeIds, true);
      return;
    }
    if (options.getVisible()) acknowledgeVisibleMessages(doc);
  });

  // Keep a durable, path-free name snapshot independent of the current open
  // document list. Closed documents can then still be named after restart.
  $effect(() => {
    const doc = options.getCtrlYdoc();
    const synced = options.getInitialSyncComplete();
    const openDocuments = options.getOpenDocuments();
    if (!doc || !synced) return;
    const names = doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES);
    doc.transact(() => {
      for (const [id, value] of names.entries()) {
        const sanitized = safeFileName(value);
        if (!sanitized) names.delete(id);
        else if (sanitized !== value) names.set(id, sanitized);
      }
      for (const open of openDocuments) {
        const fileName = safeFileName(open.fileName);
        if (fileName && names.get(open.id) !== fileName) names.set(open.id, fileName);
      }
    });
  });

  return {
    get messages() {
      return messages;
    },
    get initialSyncComplete() {
      return options.getInitialSyncComplete();
    },
    get documentFileNames() {
      return documentFileNames;
    },
    get unreadCount() {
      return unreadCount;
    },
    send(text, documentId, anchor) {
      const doc = options.getCtrlYdoc();
      const trimmed = text.trim();
      if (!doc || !trimmed) return false;
      const message: ChatMessage = {
        id: generateMessageId(),
        author: "user",
        text: trimmed,
        timestamp: Date.now(),
        ...(documentId ? { documentId } : {}),
        ...(anchor ? { anchor } : {}),
        read: false,
      };
      doc.transact(() => {
        if (documentId) {
          const open = options.getOpenDocuments().find((candidate) => candidate.id === documentId);
          const fileName = safeFileName(open?.fileName);
          if (fileName) doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).set(documentId, fileName);
        }
        doc.getMap(Y_MAP_CHAT).set(message.id, message);
      });
      return true;
    },
    acknowledgeVisible() {
      const doc = options.getCtrlYdoc();
      if (doc && options.getInitialSyncComplete() && options.getVisible()) {
        acknowledgeVisibleMessages(doc);
      }
    },
    async clear() {
      const response = await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}${API_CHAT}`, {
        method: "DELETE",
      });
      const result = (await response.json().catch(() => null)) as {
        cleared?: number;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(result?.message ?? "Chat history could not be cleared.");
      return result?.cleared ?? 0;
    },
  };
}
