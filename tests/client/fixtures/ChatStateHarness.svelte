<script lang="ts">
import type * as Y from "yjs";
import { createChatState } from "../../../src/client/hooks/useChatState.svelte";

let { doc, synced, visible }: { doc: Y.Doc; synced: boolean; visible: boolean } = $props();
const state = createChatState({
  getCtrlYdoc: () => doc,
  getInitialSyncComplete: () => synced,
  getVisible: () => visible,
});
</script>

<output data-testid="unread">{state.unreadCount}</output>
<output data-testid="message-count">{state.messages.length}</output>
