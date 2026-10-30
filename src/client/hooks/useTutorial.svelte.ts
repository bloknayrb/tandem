import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  COWORK_ENABLED,
  TUTORIAL_ANNOTATION_PREFIX,
  TUTORIAL_COMPLETED_KEY,
} from "../../shared/constants.js";
import { type Annotation, type ChatMessage, isReviewTarget } from "../../shared/types.js";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers.js";
import { AUTHORSHIP_ORIGIN_META } from "../editor/extensions/authorship.js";
import type { CoworkStatus } from "../types.js";
import { createCoalescingTick } from "../utils/coalescing-tick.js";
import { createCoworkStatus } from "./useCoworkStatus.svelte.js";

export interface TutorialState {
  readonly tutorialActive: boolean;
  /** "Accept or dismiss a comment from Claude" — ticked. */
  readonly reviewed: boolean;
  /** "Ask Claude something" — ticked. */
  readonly asked: boolean;
  /** "Make an edit" — ticked. */
  readonly edited: boolean;
  /** The Cowork row is part of this run (dark while `COWORK_ENABLED` is false). */
  readonly includeCowork: boolean;
  readonly coworkDone: boolean;
  /** Every item ticked and the Cowork status settled: the strip shows "You're ready!". */
  readonly allDone: boolean;
  readonly coworkStatus: CoworkStatus | null;
  dismissTutorial: () => void;
  completeCowork: () => void;
  /** Re-arm the checklist for replay: clears the completed flag and every tick.
   *  The caller must also (re)open welcome.md so the basename gate re-activates
   *  and the server re-injects the seed annotations. */
  restartTutorial: () => void;
}

function clearCompleted(): void {
  try {
    localStorage.removeItem(TUTORIAL_COMPLETED_KEY);
  } catch {
    // Storage unavailable — the in-memory reset below still re-arms this session
  }
}

function readCompleted(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * True iff the annotation is authored by the user AND is not a tutorial seed.
 *
 * Load-bearing: used by the "Ask Claude something" tick. A tutorial-seeded
 * annotation must NOT trip this predicate even though tutorial seeds carry
 * `author="user"` (the note, per ADR-027, and since #1725 the highlight). The
 * `TUTORIAL_ANNOTATION_PREFIX` marker is the ONLY thing distinguishing a seed
 * from a real user annotation — renaming that constant without updating this
 * predicate silently re-introduces the auto-tick bug from PR #621 PR-A2b.
 */
export function isNonTutorialUserAnnotation(a: Annotation): boolean {
  return a.author === "user" && !a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX);
}

/**
 * A user annotation that reaches Claude: a non-tutorial comment that is not
 * private. A note, or a `{comment, audience: private}`, is never shown to
 * Claude (ADR-027), so making one is not asking Claude anything.
 */
function isQuestionForClaude(a: Annotation): boolean {
  return (
    isNonTutorialUserAnnotation(a) &&
    a.type === "comment" &&
    (a as { audience?: string }).audience !== "private"
  );
}

function writeCompleted(): void {
  try {
    localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
  } catch {
    // Storage unavailable — tutorial will reappear next session
  }
}

/**
 * The first-run getting-started checklist (#1711).
 *
 * Three independent items, each ticked only by the real action, in any order:
 * accept or dismiss an annotation, ask Claude something, make an edit. There is
 * no Next button — the 4-step card it replaced was clicked through without
 * being read. When every item is ticked (and the Cowork row, if present, is
 * done) the checklist reports `allDone`, and completes itself 3 s later.
 *
 * Accepts getter functions for reactive inputs.
 */
export function createTutorial(
  getAnnotations: () => Annotation[],
  getEditor: () => Editor | null,
  getActiveTabFileName: () => string | undefined,
  getChatMessages: () => ChatMessage[],
): TutorialState {
  let completed = $state(readCompleted());
  let reviewed = $state(false);
  let asked = $state(false);
  let edited = $state(false);
  let coworkDone = $state(false);
  // The baseline for the chat and annotation terms of "Ask Claude something".
  // Set here and in `restartTutorial`, never from an effect: an arming effect
  // that ran after the `asked` effect in the same flush would leave it at 0,
  // and every earlier chat message would tick the item (#1965). Plain `let`,
  // so reading it adds no dependency.
  let armedAt = Date.now();
  // First-seen status per annotation id: true while it has been seen pending.
  // A record first seen already resolved — a restored session, or a replay
  // whose seeds the injector skipped because their ids still exist — never
  // ticks "Accept or dismiss". Plain Map, not reactive state.
  const seenPending = new Map<string, boolean>();
  const coworkSkipped = readCoworkOnboardingSkipped();

  const isWelcome = $derived(getActiveTabFileName() === "welcome.md");
  const tutorialActive = $derived(!completed && isWelcome);

  // One value feeds all three readers below. While Cowork ships dark the
  // poller never runs, so a `coworkStatusSettled` still keyed on Tauri alone
  // would wait forever on a status that cannot arrive and the desktop
  // checklist would never complete.
  const cowork = COWORK_ENABLED && isTauriRuntime();

  // Cowork row eligibility — part of `allDone` when present.
  const coworkState = createCoworkStatus(() => cowork && tutorialActive);

  const coworkStatusSettled = $derived(
    !cowork || coworkState.status !== null || coworkState.error !== null,
  );
  const includeCoworkStep = $derived(
    cowork && shouldShowCoworkOnboarding(coworkState.status, coworkSkipped),
  );
  const allDone = $derived(
    coworkStatusSettled && reviewed && asked && edited && (!includeCoworkStep || coworkDone),
  );

  // "Accept or dismiss a comment from Claude": a review target seen pending is now
  // accepted or dismissed. Any review target counts, not only seeds, so a
  // replay whose seeds are all stale can still tick on a real one. Known
  // limit: Claude resolving an annotation over MCP writes the same status and
  // ticks this too — nothing on the record says who resolved it.
  $effect(() => {
    if (!tutorialActive || reviewed) return;
    for (const a of getAnnotations()) {
      if (!isReviewTarget(a)) continue;
      const wasPending = seenPending.get(a.id);
      if (wasPending === undefined) {
        seenPending.set(a.id, a.status === "pending");
      } else if (wasPending && a.status !== "pending") {
        reviewed = true;
        return;
      }
    }
  });

  // "Ask Claude something": a question comment (see isQuestionForClaude) or a
  // chat message the user sent after arming (#1965). The `timestamp > armedAt`
  // terms are required, not a refinement: chat is durable and app-global (the
  // session manager snapshots and restores Y_MAP_CHAT, `useChatState`
  // repopulates from the ctrl Y.Doc on connect, and `documentId` is optional),
  // `restartTutorial` cannot clear chat history, and a replay keeps every
  // annotation on welcome.md — so without them a replay ticks this at once.
  // Both timestamps are the browser's `Date.now()`, like `armedAt`.
  $effect(() => {
    if (!tutorialActive || asked) return;
    if (
      getAnnotations().some((a) => isQuestionForClaude(a) && a.timestamp > armedAt) ||
      getChatMessages().some((m) => m.author === "user" && m.timestamp > armedAt)
    ) {
      asked = true;
    }
  });

  // "Make an edit": a focused, local, user-authored change. Skipped:
  // - ySync-tagged transactions — a remote change, including Claude's
  //   `tandem_edit`, which Tiptap reports through the same `update` event;
  // - Claude-authored local writes — accepting a suggestion applies it as a
  //   local transaction tagged `AUTHORSHIP_ORIGIN_META: "claude"` (#1388), and
  //   that accept is pressed from inside the editor, so focus alone would let
  //   it tick this item too.
  // The `$state` write is deferred through a coalescing tick: never write
  // `$state` synchronously from a Tiptap event handler (CLAUDE.md).
  const markEdited = createCoalescingTick(() => {
    if (tutorialActive && !edited) edited = true;
  });
  $effect(() => {
    if (!tutorialActive || edited) return;
    const editor = getEditor();
    if (!editor) return;

    const handler = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      if (transaction.getMeta(ySyncPluginKey)) return;
      if (transaction.getMeta(AUTHORSHIP_ORIGIN_META) === "claude") return;
      if (!editor.isFocused) return;
      markEdited();
    };

    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  });

  // Every item ticked: show "You're ready!" for 3 s, then complete.
  $effect(() => {
    if (!tutorialActive || !allDone) return;
    const timer = setTimeout(() => {
      writeCompleted();
      completed = true;
    }, 3000);
    return () => clearTimeout(timer);
  });

  const dismissTutorial = () => {
    writeCompleted();
    completed = true;
  };

  const completeCowork = () => {
    coworkDone = true;
  };

  const restartTutorial = () => {
    clearCompleted();
    completed = false;
    reviewed = false;
    asked = false;
    edited = false;
    coworkDone = false;
    armedAt = Date.now();
    seenPending.clear();
  };

  return {
    get tutorialActive() {
      return tutorialActive;
    },
    get reviewed() {
      return reviewed;
    },
    get asked() {
      return asked;
    },
    get edited() {
      return edited;
    },
    get includeCowork() {
      return includeCoworkStep;
    },
    get coworkDone() {
      return coworkDone;
    },
    get allDone() {
      return allDone;
    },
    get coworkStatus() {
      return coworkState.status;
    },
    dismissTutorial,
    completeCowork,
    restartTutorial,
  };
}
