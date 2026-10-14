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
}: {
  doc: Y.Doc;
  synced: boolean;
  visible: boolean;
  initialClaudeIds?: readonly string[];
  openDocuments?: readonly { id: string; fileName: string }[];
  onClaudeReplies?: (replies: ChatMessage[]) => void;
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
});
</script>

<output data-testid="unread">{state.unreadCount}</output>
<output data-testid="message-count">{state.messages.length}</output>
<output data-testid="message-texts">{JSON.stringify(state.messages.map((m) => m.text))}</output>
<output data-testid="document-names">{JSON.stringify(Array.from(state.documentFileNames))}</output>
