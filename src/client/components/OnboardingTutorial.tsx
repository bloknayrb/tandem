import { useMemo } from "react";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers";
import type { CoworkStatus } from "../types";
import { CoworkOnboardingStep } from "./CoworkOnboardingStep";

interface OnboardingTutorialProps {
  currentStep: number;
  onNext: () => void;
  onDismiss: () => void;
  coworkStatus: CoworkStatus | null;
}

const BASE_STEPS = [
  {
    id: "review",
    title: "Review an annotation",
    text: "Open the side panel and accept or dismiss one of the highlighted annotations. Try Review Mode (Ctrl+Shift+R) for keyboard shortcuts.",
  },
  {
    id: "question",
    title: "Ask a question",
    text: "Select text, click Comment, and check the @Claude toggle to direct it to Claude — or type in the Chat panel.",
  },
  {
    id: "edit",
    title: "Make an edit",
    text: "Click in the document and type something. All changes sync in real-time.",
  },
  {
    id: "cowork",
    title: "Claude Desktop Cowork detected",
    // Dynamic body — rendered via <CoworkOnboardingStep/>
    text: "",
  },
  {
    id: "complete",
    title: "You're ready!",
    text: "You've learned the basics. Press ? anytime to see keyboard shortcuts.",
  },
] as const;

export function OnboardingTutorial({
  currentStep,
  onNext,
  onDismiss,
  coworkStatus,
}: OnboardingTutorialProps) {
  const tauri = isTauriRuntime();
  const skipped = useMemo(readCoworkOnboardingSkipped, []);
  const showCowork = tauri && shouldShowCoworkOnboarding(coworkStatus, skipped);

  // Filter out the cowork step when it's not applicable. The visible
  // currentStep indexes into this filtered list, so non-Tauri callers see
  // the same 4-step flow they always saw.
  const activeSteps = useMemo(
    () => BASE_STEPS.filter((s) => s.id !== "cowork" || showCowork),
    [showCowork],
  );
  const totalActionable = activeSteps.length - 1; // exclude the completion step
  const step = activeSteps[currentStep];
  if (!step) return null;

  const isComplete = currentStep >= totalActionable;
  const isCoworkStep = step.id === "cowork";

  return (
    <div
      data-testid="onboarding-tutorial"
      style={{
        position: "fixed",
        bottom: 48,
        left: 24,
        zIndex: 900,
        maxWidth: 340,
        background: "var(--tandem-surface)",
        borderLeft: "4px solid var(--tandem-accent)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.08)",
        padding: "16px 20px",
        fontFamily: "inherit",
      }}
    >
      {!isComplete && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {Array.from({ length: totalActionable }, (_, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: i <= currentStep ? "var(--tandem-accent)" : "var(--tandem-border)",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>
      )}

      {isCoworkStep && coworkStatus !== null ? (
        // The Cowork step owns its Enable / Skip / Learn-more buttons and
        // drives advancement via `onAdvance`, so we don't render the shared
        // Dismiss / Next footer here.
        <CoworkOnboardingStep status={coworkStatus} onAdvance={onNext} />
      ) : (
        <>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--tandem-fg)",
              marginBottom: 6,
            }}
          >
            {step.title}
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--tandem-fg-muted)",
              marginBottom: isComplete ? 0 : 14,
            }}
          >
            {step.text}
          </div>
        </>
      )}

      {!isComplete && !isCoworkStep && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--tandem-fg-subtle)" }}>
            Step {currentStep + 1} of {totalActionable}
          </span>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              data-testid="tutorial-dismiss-btn"
              onClick={onDismiss}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--tandem-fg-subtle)",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              Dismiss tutorial
            </button>
            <button
              data-testid="tutorial-next-btn"
              onClick={onNext}
              style={{
                padding: "4px 12px",
                fontSize: 12,
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: 4,
                background: "var(--tandem-surface)",
                color: "var(--tandem-fg-muted)",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {currentStep === totalActionable - 1 ? "Done" : "Next"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
