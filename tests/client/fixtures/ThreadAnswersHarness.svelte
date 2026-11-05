<script lang="ts">
import type * as Y from "yjs";
import {
  createThreadAnswers,
  type ThreadAnswers,
  type ThreadAnswerTab,
} from "../../../src/client/hooks/useThreadAnswers.svelte";
import type {
  ReplyBaseline,
  ThreadAnswer,
} from "../../../src/client/notifications/thread-answer-detector";

let {
  tabs,
  baselines,
  ctrl,
  ctrlSynced = true,
  activeDocumentId = null,
  windowActive = true,
  onAnswers,
  onReady,
}: {
  tabs: ThreadAnswerTab[];
  baselines: ReadonlyMap<Y.Doc, ReplyBaseline>;
  ctrl: Y.Doc;
  ctrlSynced?: boolean;
  activeDocumentId?: string | null;
  windowActive?: boolean;
  onAnswers?: (answers: ThreadAnswer[]) => void;
  onReady: (answers: ThreadAnswers) => void;
} = $props();

const answers = createThreadAnswers({
  getTabs: () => tabs,
  getReplyBaselines: () => baselines,
  getCtrlYdoc: () => ctrl,
  getCtrlSynced: () => ctrlSynced,
  getActiveDocumentId: () => activeDocumentId,
  isWindowActive: () => windowActive,
  get onAnswers() {
    return onAnswers;
  },
});
// svelte-ignore state_referenced_locally
onReady(answers);
</script>
