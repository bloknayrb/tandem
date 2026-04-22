import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { TUTORIAL_ANNOTATION_PREFIX, TUTORIAL_COMPLETED_KEY } from "../../shared/constants";
import type { Annotation } from "../../shared/types";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers";
import type { CoworkStatus } from "../types";
import { useCoworkStatus } from "./useCoworkStatus";

interface UseTutorialResult {
  tutorialActive: boolean;
  currentStep: number;
  dismissTutorial: () => void;
  nextStep: () => void;
  coworkStatus: CoworkStatus | null;
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
 * Drives the onboarding tutorial through 4–5 steps. The Cowork step (index 3)
 * is only present when running under Tauri AND the Rust side reports an
 * eligible Cowork install that isn't already enabled. Index numbering:
 *   0 — Review an annotation (detect any tutorial annotation resolved)
 *   1 — Ask a question (detect user annotation or chat)
 *   2 — Make an edit (detect editor content change while focused)
 *   3 — Cowork (conditional) OR Completion
 *   4 — Completion (only when Cowork is present)
 * The `totalSteps` local tracks the max index so the step 2→next advance lands
 * on the right completion index regardless of whether Cowork is visible.
 */
export function useTutorial(
  annotations: Annotation[],
  editorRef: React.RefObject<Editor | null>,
  activeTabFileName: string | undefined,
): UseTutorialResult {
  const [completed, setCompleted] = useState(readCompleted);
  const [currentStep, setCurrentStep] = useState(0);
  const stepAdvancedAt = useRef<number>(0);

  const isWelcome = activeTabFileName === "welcome.md";
  const tutorialActive = !completed && isWelcome;

  // Cowork step eligibility — drives the step count so step 2 advances to
  // the right completion index (3 when no Cowork, 4 when Cowork is inserted).
  const tauri = isTauriRuntime();
  const { status: coworkStatus, error: coworkStatusError } = useCoworkStatus(
    tauri && tutorialActive,
  );
  const [coworkSkipped] = useState(readCoworkOnboardingSkipped);
  const coworkStatusSettled = !tauri || coworkStatus !== null || coworkStatusError !== null;
  const includeCoworkStep = tauri && shouldShowCoworkOnboarding(coworkStatus, coworkSkipped);
  const completionStep = coworkStatusSettled ? (includeCoworkStep ? 4 : 3) : Infinity;

  // Step 0: detect any tutorial annotation resolved, or auto-skip if none exist
  useEffect(() => {
    if (!tutorialActive || currentStep !== 0) return;
    const tutorialAnns = annotations.filter((a) => a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX));
    if (tutorialAnns.length === 0) {
      // No tutorial annotations found — auto-skip to step 1
      return;
    }
    const resolved = tutorialAnns.some((a) => a.status !== "pending");
    if (resolved) {
      stepAdvancedAt.current = Date.now();
      setCurrentStep(1);
    }
  }, [tutorialActive, currentStep, annotations]);

  // Step 1: detect user-authored annotation
  useEffect(() => {
    if (!tutorialActive || currentStep !== 1) return;
    const hasUserAnnotation = annotations.some((a) => a.author === "user");
    if (hasUserAnnotation) {
      stepAdvancedAt.current = Date.now();
      setCurrentStep(2);
    }
  }, [tutorialActive, currentStep, annotations]);

  // Step 2: detect editor content change (user typed something while editor is focused)
  // Uses editorRef.current identity — re-attaches listener on tab switch/remount
  const editor = editorRef.current;
  useEffect(() => {
    if (!tutorialActive || currentStep !== 2 || !isFinite(completionStep)) return;
    if (!editor) return;

    const handler = () => {
      // Ignore updates within 2s of step advance (avoids false positive from suggestion accept)
      if (Date.now() - stepAdvancedAt.current < 2000) return;
      // Only count edits when user is actively focused (filters CRDT syncs)
      if (!editor.isFocused) return;
      stepAdvancedAt.current = Date.now();
      setCurrentStep(3);
    };

    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [tutorialActive, currentStep, completionStep, editor]);

  // Completion step: auto-complete after 3 seconds. Completion index is 3
  // when no Cowork step is inserted, 4 when it is.
  useEffect(() => {
    if (!tutorialActive || !isFinite(completionStep) || currentStep !== completionStep) return;
    const timer = setTimeout(() => {
      writeCompleted();
      setCompleted(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [tutorialActive, currentStep, completionStep]);

  useEffect(() => {
    if (isFinite(completionStep)) {
      setCurrentStep((prev) => Math.min(prev, completionStep));
    }
  }, [completionStep]);

  const dismissTutorial = useCallback(() => {
    writeCompleted();
    setCompleted(true);
  }, []);

  const nextStep = useCallback(() => {
    stepAdvancedAt.current = Date.now();
    setCurrentStep((prev) => Math.min(prev + 1, completionStep));
  }, [completionStep]);

  return {
    tutorialActive,
    currentStep,
    dismissTutorial,
    nextStep,
    coworkStatus,
  };
}
