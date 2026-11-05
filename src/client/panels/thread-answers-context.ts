import { getContext, setContext } from "svelte";
import type { ThreadAnswers } from "../hooks/useThreadAnswers.svelte";

/**
 * #2360: hands App's `ThreadAnswers` to every `ReplyThread` without threading a
 * prop through SidePanel, MarginColumn and AnnotationCard. A ReplyThread
 * mounted without it (tests, any future surface) behaves exactly as before:
 * no auto-open for answers, no "new" marker, nothing marked seen.
 */
const KEY = Symbol("tandem-thread-answers");

export function setThreadAnswersContext(answers: ThreadAnswers): void {
  setContext(KEY, answers);
}

export function getThreadAnswersContext(): ThreadAnswers | undefined {
  return getContext<ThreadAnswers | undefined>(KEY);
}
