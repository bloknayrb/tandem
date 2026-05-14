import type { Editor } from "@tiptap/core";
import { TUTORIAL_ANNOTATION_PREFIX, TUTORIAL_COMPLETED_KEY } from "../../shared/constants.js";
import type { Annotation } from "../../shared/types.js";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers.js";
import type { CoworkStatus } from "../types.js";
import { createCoworkStatus } from "./useCoworkStatus.svelte.js";

export interface TutorialState {
  readonly tutorialActive: boolean;
  readonly currentStep: number;
  readonly coworkStatus: CoworkStatus | null;
  dismissTutorial: () => void;
  nextStep: () => void;
}

function readCompleted(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCompleted(): void {
  try {
    localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
  } catch {
    // Storage unavailable — tutorial will reappear next session
  }
}

/**
 * Svelte 5 port of `useTutorial`.
 *
 * Drives the onboarding tutorial through 4–5 steps. The Cowork step (index 3)
 * is only present when running under Tauri AND the Rust side reports an
 * eligible Cowork install that isn't already enabled.
 *
 * Accepts getter functions for reactive inputs.
 */
export function createTutorial(
  getAnnotations: () => Annotation[],
  getEditor: () => Editor | null,
  getActiveTabFileName: () => string | undefined,
): TutorialState {
  let completed = $state(readCompleted());
  let currentStep = $state(0);
  let stepAdvancedAt = 0;
  const coworkSkipped = readCoworkOnboardingSkipped();

  const isWelcome = $derived(getActiveTabFileName() === "welcome.md");
  const tutorialActive = $derived(!completed && isWelcome);

  const tauri = isTauriRuntime();

  // Cowork step eligibility — drives the step count so step 2 advances to
  // the right completion index (3 when no Cowork, 4 when Cowork is inserted).
  const coworkState = createCoworkStatus(() => tauri && tutorialActive);

  const coworkStatusSettled = $derived(
    !tauri || coworkState.status !== null || coworkState.error !== null,
  );
  const includeCoworkStep = $derived(
    tauri && shouldShowCoworkOnboarding(coworkState.status, coworkSkipped),
  );
  const completionStep = $derived(coworkStatusSettled ? (includeCoworkStep ? 4 : 3) : Infinity);

  // Step 0: detect any tutorial annotation resolved, or auto-skip if none exist
  $effect(() => {
    if (!tutorialActive || currentStep !== 0) return;
    const annotations = getAnnotations();
    const tutorialAnns = annotations.filter((a) => a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX));
    if (tutorialAnns.length === 0) return;
    const resolved = tutorialAnns.some((a) => a.status !== "pending");
    if (resolved) {
      stepAdvancedAt = Date.now();
      currentStep = 1;
    }
  });

  // Step 1: detect user-authored annotation (excluding the tutorial's own
  // seeded note, which is author='user' per ADR-027 since notes are private
  // and Claude can't author user content)
  $effect(() => {
    if (!tutorialActive || currentStep !== 1) return;
    const annotations = getAnnotations();
    const hasUserAnnotation = annotations.some(
      (a) => a.author === "user" && !a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX),
    );
    if (hasUserAnnotation) {
      stepAdvancedAt = Date.now();
      currentStep = 2;
    }
  });

  // Step 2: detect editor content change
  $effect(() => {
    if (!tutorialActive || currentStep !== 2 || !isFinite(completionStep)) return;
    const editor = getEditor();
    if (!editor) return;

    const handler = () => {
      if (Date.now() - stepAdvancedAt < 2000) return;
      if (!editor.isFocused) return;
      stepAdvancedAt = Date.now();
      currentStep = 3;
    };

    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  });

  // Completion step: auto-complete after 3 seconds
  $effect(() => {
    if (!tutorialActive || !isFinite(completionStep) || currentStep !== completionStep) return;
    const timer = setTimeout(() => {
      writeCompleted();
      completed = true;
    }, 3000);
    return () => clearTimeout(timer);
  });

  // Clamp current step when completionStep changes
  $effect(() => {
    if (isFinite(completionStep)) {
      if (currentStep > completionStep) {
        currentStep = completionStep;
      }
    }
  });

  const dismissTutorial = () => {
    writeCompleted();
    completed = true;
  };

  const nextStep = () => {
    stepAdvancedAt = Date.now();
    currentStep = Math.min(currentStep + 1, completionStep);
  };

  return {
    get tutorialActive() {
      return tutorialActive;
    },
    get currentStep() {
      return currentStep;
    },
    get coworkStatus() {
      return coworkState.status;
    },
    dismissTutorial,
    nextStep,
  };
}
