import * as Y from "yjs";
import {
  DEFAULT_MCP_PORT,
  Y_MAP_CHAT,
  Y_MAP_CHAT_SEEN,
  Y_MAP_CHAT_SEEN_INITIALIZED,
} from "../../shared/constants";
import { API_CHAT } from "../../shared/api-paths";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { generateMessageId } from "../../shared/utils";

const MAX_SEEN_MESSAGE_IDS = 400;

export interface ChatState {
  readonly messages: ChatMessage[];
  readonly initialSyncComplete: boolean;
  readonly unreadCount: number;
  send(text: string, documentId?: string, anchor?: CapturedAnchor | null): boolean;
  acknowledgeVisible(): void;
  clear(): Promise<number>;
}

export function createChatState(options: {
  getCtrlYdoc: () => Y.Doc | null;
  getInitialSyncComplete: () => boolean;
  getVisible: () => boolean;
}): ChatState {
  let messages = $state<ChatMessage[]>([]);
  let seenIds = $state(new Set<string>());
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

  function acknowledge(doc: Y.Doc, baseline = false): void {
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    doc.transact(() => {
      if (baseline && seen.get(Y_MAP_CHAT_SEEN_INITIALIZED) !== true) {
        seen.set(Y_MAP_CHAT_SEEN_INITIALIZED, true);
      }
      for (const message of messages) {
        if (message.author === "claude" && seen.get(message.id) !== true)
          seen.set(message.id, true);
      }
      pruneSeen(doc);
    });
  }

  $effect(() => {
    const doc = options.getCtrlYdoc();
    if (!doc) {
      messages = [];
      seenIds = new Set();
      return;
    }
    const chat = doc.getMap(Y_MAP_CHAT);
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    const observer = () => refresh(doc);
    chat.observe(observer);
    seen.observe(observer);
    observer();
    return () => {
      chat.unobserve(observer);
      seen.unobserve(observer);
    };
  });

  // Do not baseline an empty pre-sync document. The provider's first synced
  // boundary establishes the authoritative history for first-rollout marking.
  $effect(() => {
    const doc = options.getCtrlYdoc();
    const synced = options.getInitialSyncComplete();
    void messages;
    if (!doc || !synced) return;
    const seen = doc.getMap(Y_MAP_CHAT_SEEN);
    if (seen.get(Y_MAP_CHAT_SEEN_INITIALIZED) !== true) {
      acknowledge(doc, true);
      return;
    }
    if (options.getVisible()) acknowledge(doc);
  });

  return {
    get messages() {
      return messages;
    },
    get initialSyncComplete() {
      return options.getInitialSyncComplete();
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
      doc.getMap(Y_MAP_CHAT).set(message.id, message);
      return true;
    },
    acknowledgeVisible() {
      const doc = options.getCtrlYdoc();
      if (doc && options.getInitialSyncComplete() && options.getVisible()) acknowledge(doc);
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
