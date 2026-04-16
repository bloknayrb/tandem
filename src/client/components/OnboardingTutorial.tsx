interface OnboardingTutorialProps {
  currentStep: number;
  onNext: () => void;
  onDismiss: () => void;
}

const STEPS = [
  {
    title: "Review an annotation",
    text: "Open the side panel and accept or dismiss one of the highlighted annotations. Try Review Mode (Ctrl+Shift+R) for keyboard shortcuts.",
  },
  {
    title: "Ask a question",
    text: "Select text, click Comment, and check the @Claude toggle to direct it to Claude — or type in the Chat panel.",
  },
  {
    title: "Make an edit",
    text: "Click in the document and type something. All changes sync in real-time.",
  },
  {
    title: "You're ready!",
    text: "You've learned the basics. Press ? anytime to see keyboard shortcuts.",
  },
] as const;

/** Steps 0-2 are actionable; step 3 is the completion message */
const TOTAL_STEPS = 3;

export function OnboardingTutorial({ currentStep, onNext, onDismiss }: OnboardingTutorialProps) {
  const step = STEPS[currentStep];
  if (!step) return null;

  const isComplete = currentStep >= TOTAL_STEPS;

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
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
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

      {!isComplete && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--tandem-fg-subtle)" }}>
            Step {currentStep + 1} of {TOTAL_STEPS}
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
              {currentStep === TOTAL_STEPS - 1 ? "Done" : "Next"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
