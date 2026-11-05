<script lang="ts">
import type { ThreadAnswers } from "../../../src/client/hooks/useThreadAnswers.svelte";
import ReplyThread from "../../../src/client/panels/ReplyThread.svelte";
import { setThreadAnswersContext } from "../../../src/client/panels/thread-answers-context";
import type { Annotation, AnnotationReply } from "../../../src/shared/types";

let {
  answers,
  annotation,
  replies,
}: { answers: ThreadAnswers; annotation: Annotation; replies: AnnotationReply[] } = $props();
// svelte-ignore state_referenced_locally
setThreadAnswersContext(answers);
</script>

<ReplyThread {annotation} {replies} isPending={true} isEditing={false} aiDisabled={false} />
