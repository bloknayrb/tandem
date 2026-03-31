import { useState, useEffect, useCallback, useRef } from "react";

import type { Editor } from "@tiptap/core";

import { TUTORIAL_COMPLETED_KEY, TUTORIAL_ANNOTATION_PREFIX } from "../../shared/constants";
import type { Annotation } from "../../shared/types";

interface UseTutorialResult {
  tutorialActive: boolean;
  currentStep: number;
  dismissTutorial: () => void;
  skipStep: () => void;
}

/**
 * Drives the onboarding tutorial through 4 steps (0-3):
 *   0 — Review an annotation (detect any tutorial annotation resolved)
 *   1 — Ask a question (detect user annotation or chat)
 *   2 — Make an edit (detect editor content change)
 *   3 — Complete (auto-dismiss after 3s)
 */
export function useTutorial(
  annotations: Annotation[],
  editorRef: React.RefObject<Editor | null>,
  activeTabFileName: string | undefined,
): UseTutorialResult {
  const [completed, setCompleted] = useState(
    () => localStorage.getItem(TUTORIAL_COMPLETED_KEY) === "true",
  );
  const [currentStep, setCurrentStep] = useState(0);
  const stepAdvancedAt = useRef<number>(0);

  const isWelcome = activeTabFileName === "welcome.md";
  const tutorialActive = !completed && isWelcome;

  // Step 0: detect any tutorial annotation resolved (accepted or dismissed)
  useEffect(() => {
    if (!tutorialActive || currentStep !== 0) return;
    const resolved = annotations.some(
      (a) => a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX) && a.status !== "pending",
    );
    if (resolved) {
      stepAdvancedAt.current = Date.now();
      setCurrentStep(1);
    }
  }, [tutorialActive, currentStep, annotations]);

  // Step 1: detect user-authored annotation or allow manual skip
  useEffect(() => {
    if (!tutorialActive || currentStep !== 1) return;
    const hasUserAnnotation = annotations.some((a) => a.author === "user");
    if (hasUserAnnotation) {
      stepAdvancedAt.current = Date.now();
      setCurrentStep(2);
    }
  }, [tutorialActive, currentStep, annotations]);

  // Step 2: detect editor content change (user typed something)
  useEffect(() => {
    if (!tutorialActive || currentStep !== 2) return;
    const editor = editorRef.current;
    if (!editor) return;

    const handler = () => {
      // Ignore updates within 2s of step advance to avoid false positives
      // from suggestion acceptance in step 0
      if (Date.now() - stepAdvancedAt.current < 2000) return;
      stepAdvancedAt.current = Date.now();
      setCurrentStep(3);
    };

    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [tutorialActive, currentStep, editorRef]);

  // Step 3: auto-complete after 3 seconds
  useEffect(() => {
    if (!tutorialActive || currentStep !== 3) return;
    const timer = setTimeout(() => {
      localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
      setCompleted(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [tutorialActive, currentStep]);

  const dismissTutorial = useCallback(() => {
    localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
    setCompleted(true);
  }, []);

  const skipStep = useCallback(() => {
    stepAdvancedAt.current = Date.now();
    setCurrentStep((prev) => Math.min(prev + 1, 3));
  }, []);

  return {
    tutorialActive,
    currentStep,
    dismissTutorial,
    skipStep,
  };
}
