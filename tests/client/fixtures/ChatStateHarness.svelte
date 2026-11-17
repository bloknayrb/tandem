<script lang="ts">
import type * as Y from "yjs";
import type { ChatMessage } from "../../../src/shared/types";
import { createChatState } from "../../../src/client/hooks/useChatState.svelte";

let {
  doc,
  synced,
  visible,
  initialClaudeIds = [],
  openDocuments = [],
  onClaudeReplies,
  onNoticeRows,
  onSent,
  sendText,
}: {
  doc: Y.Doc;
  synced: boolean;
  visible: boolean;
  initialClaudeIds?: readonly string[];
  openDocuments?: readonly { id: string; fileName: string }[];
  onClaudeReplies?: (replies: ChatMessage[]) => void;
  onNoticeRows?: (notices: ChatMessage[]) => void;
  onSent?: (message: ChatMessage) => void;
  /** When set, a button sends it (a click: the user's send handler). */
  sendText?: string;
} = $props();
const state = createChatState({
  getCtrlYdoc: () => doc,
  getInitialSyncComplete: () => synced,
  getInitialClaudeMessageIds: () => initialClaudeIds,
  getOpenDocuments: () => openDocuments,
  getVisible: () => visible,
  get onClaudeReplies() {
    return onClaudeReplies;
  },
  get onNoticeRows() {
    return onNoticeRows;
  },
  get onSent() {
    return onSent;
  },
});
</script>

{#if sendText}<button data-testid="send" onclick={() => state.send(sendText)}>send</button>{/if}

<output data-testid="unread">{state.unreadCount}</output>
<output data-testid="message-count">{state.messages.length}</output>
<output data-testid="message-texts">{JSON.stringify(state.messages.map((m) => m.text))}</output>
<output data-testid="document-names">{JSON.stringify(Array.from(state.documentFileNames))}</output>
