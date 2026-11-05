import type { ThreadAnswers } from "../../../src/client/hooks/useThreadAnswers.svelte";

/**
 * A reactive stand-in for App's `ThreadAnswers`, for ReplyThread specs. Its
 * `markSeen` honours window activity the way the real one does (a reactive
 * read), and records each write.
 */
export function createFakeThreadAnswers(initialUnseen: string[] = []) {
  let unseen = $state<string[]>(initialUnseen);
  let active = $state(true);
  const marked: string[][] = [];
  const answers: ThreadAnswers = {
    activeDocumentId: "doc-1",
    isSeen: () => false,
    unseenAnswerIds: () => unseen,
    markSeen(_documentId, ids) {
      if (!active) return;
      marked.push([...ids]);
      unseen = unseen.filter((id) => !ids.includes(id));
    },
  };
  return {
    answers,
    marked,
    setUnseen(ids: string[]) {
      unseen = ids;
    },
    setActive(value: boolean) {
      active = value;
    },
  };
}
