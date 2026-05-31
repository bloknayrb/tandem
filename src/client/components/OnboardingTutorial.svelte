<script lang="ts">
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers";
import type { CoworkStatus } from "../types";
import CoworkOnboardingStep from "./CoworkOnboardingStep.svelte";

interface Props {
  currentStep: number;
  onNext: () => void;
  onDismiss: () => void;
  coworkStatus: CoworkStatus | null;
}

let { currentStep, onNext, onDismiss, coworkStatus }: Props = $props();

const BASE_STEPS = [
  {
    id: "review",
    title: "Review an annotation",
    text: "Open the side panel and accept or dismiss one of the highlighted annotations. Try Review Mode (Ctrl+Shift+R) for keyboard shortcuts.",
  },
  {
    id: "question",
    title: "Ask a question",
    text: "Select text and click Comment to send a question to your AI assistant — or click Note to keep a private thought to yourself. You can also use the Chat panel.",
  },
  {
    id: "edit",
    title: "Make an edit",
    text: "Click in the document and type something. All changes sync in real-time.",
  },
  {
    id: "cowork",
    title: "Claude Desktop Cowork detected",
    text: "",
  },
  {
    id: "complete",
    title: "You're ready!",
    text: "You've learned the basics. Press ? anytime to see keyboard shortcuts.",
  },
] as const;

const tauri = isTauriRuntime();
const skipped = readCoworkOnboardingSkipped();

const showCowork = $derived(tauri && shouldShowCoworkOnboarding(coworkStatus, skipped));
const activeSteps = $derived(BASE_STEPS.filter((s) => s.id !== "cowork" || showCowork));
const totalActionable = $derived(activeSteps.length - 1);
const step = $derived(activeSteps[currentStep]);
const isComplete = $derived(currentStep >= totalActionable);
const isCoworkStep = $derived(step?.id === "cowork");
</script>

{#if step}
  <div
    data-testid="onboarding-tutorial"
    style="position: fixed; bottom: 48px; left: 24px; z-index: var(--tandem-z-overlay); max-width: 340px; background: var(--tandem-surface); border-left: 4px solid var(--tandem-accent); border-radius: var(--tandem-r-4); box-shadow: var(--tandem-shadow-2); padding: var(--tandem-space-4) var(--tandem-space-5); font-family: inherit;"
  >
    {#if !isComplete}
      <div style="display: flex; gap: var(--tandem-space-1); margin-bottom: var(--tandem-space-3);">
        {#each Array.from({ length: totalActionable }, (_, i) => i) as i (i)}
          <div
            style="width: var(--tandem-space-2); height: var(--tandem-space-2); border-radius: var(--tandem-r-circle); background: {i <= currentStep ? 'var(--tandem-accent)' : 'var(--tandem-border)'}; transition: background 0.2s;"
          ></div>
        {/each}
      </div>
    {/if}

    {#if isCoworkStep && coworkStatus !== null}
      <CoworkOnboardingStep status={coworkStatus} onAdvance={onNext} />
    {:else}
      <div style="font-size: var(--tandem-text-sm); font-weight: 600; color: var(--tandem-fg); margin-bottom: var(--tandem-space-1);">
        {step.title}
      </div>
      <div style="font-size: var(--tandem-text-base); line-height: 1.5; color: var(--tandem-fg-muted); margin-bottom: {isComplete ? 0 : 14}px;">
        {step.text}
      </div>
    {/if}

    {#if !isComplete && !isCoworkStep}
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);">
          Step {currentStep + 1} of {totalActionable}
        </span>
        <div style="display: flex; gap: 12px; align-items: center;">
          <button
            data-testid="tutorial-dismiss-btn"
            onclick={onDismiss}
            style="background: none; border: none; cursor: pointer; font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle); padding: 0; text-decoration: underline;"
          >
            Dismiss tutorial
          </button>
          <button
            data-testid="tutorial-next-btn"
            onclick={onNext}
            style="padding: var(--tandem-space-1) var(--tandem-space-3); font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-pill); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer; font-weight: 500;"
          >
            {currentStep === totalActionable - 1 ? "Done" : "Next"}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}
