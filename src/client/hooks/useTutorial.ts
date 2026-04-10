import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { TUTORIAL_ANNOTATION_PREFIX, TUTORIAL_COMPLETED_KEY } from "../../shared/constants";
import type { Annotation } from "../../shared/types";

interface UseTutorialResult {
  tutorialActive: boolean;
  currentStep: number;
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
 * Drives the onboarding tutorial through 4 steps (0-3):
 *   0 — Review an annotation (detect any tutorial annotation resolved)
 *   1 — Ask a question (detect user annotation or chat)
 *   2 — Make an edit (detect editor content change while focused)
 *   3 — Complete (auto-dismiss after 3s)
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
    if (!tutorialActive || currentStep !== 2) return;
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
  }, [tutorialActive, currentStep, editor]);

  // Step 3: auto-complete after 3 seconds
  useEffect(() => {
    if (!tutorialActive || currentStep !== 3) return;
    const timer = setTimeout(() => {
      writeCompleted();
      setCompleted(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [tutorialActive, currentStep]);

  const dismissTutorial = useCallback(() => {
    writeCompleted();
    setCompleted(true);
  }, []);

  const nextStep = useCallback(() => {
    stepAdvancedAt.current = Date.now();
    setCurrentStep((prev) => Math.min(prev + 1, 3));
  }, []);

  return {
    tutorialActive,
    currentStep,
    dismissTutorial,
    nextStep,
  };
}
