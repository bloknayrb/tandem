<script lang="ts">
import { fade } from "svelte/transition";
import {
  isTauriRuntime,
  readCoworkOnboardingSkipped,
  shouldShowCoworkOnboarding,
} from "../cowork/cowork-helpers";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";
import { motionOff } from "../panels/cardMotion";
import type { CoworkStatus } from "../types";
import CoworkOnboardingStep from "./CoworkOnboardingStep.svelte";

interface Props {
  currentStep: number;
  onNext: () => void;
  onDismiss: () => void;
  coworkStatus: CoworkStatus | null;
}

let { currentStep, onNext, onDismiss, coworkStatus }: Props = $props();

// A22 (#798): panel cross-fade duration. `$derived` (not `const`) so it tracks a
// live in-app reduce-motion toggle; `motionOff` OR-s that with the OS preference.
// (The dot-pop respects reduce-motion via its CSS dual-guard in the style block.)
const tandemSettings = createTandemSettings();
const fadeMs = $derived(motionOff(tandemSettings.settings.reduceMotion) ? 0 : 220);

const BASE_STEPS = [
  {
    id: "review",
    title: "Review an annotation",
    text: "Open the side panel and accept or dismiss one of the highlighted annotations — or turn on the margin view to see them beside the text. Try Review Mode (Ctrl+Shift+R) for keyboard shortcuts.",
  },
  {
    id: "question",
    title: "Ask a question",
    text: "Select text and click Annotate, then send it to your AI assistant — or keep it as a private note to yourself. You can also use the Chat panel.",
  },
  {
    id: "edit",
    title: "Make an edit",
    text: "Click in the document and type something. All changes sync in real-time. Open a tab or scratchpad with Ctrl+N, and jump anywhere with the command palette (Ctrl+Shift+P).",
  },
  {
    id: "cowork",
    title: "Claude Desktop Cowork detected",
    text: "",
  },
  {
    id: "complete",
    title: "You're ready!",
    text: "You've learned the basics. Press ? anytime for keyboard shortcuts, or Ctrl+Shift+, to customize them.",
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
    <!-- A22 (#798): progress dots. This row MUST stay OUTSIDE the {#key step.id}
         body block below — the next-dot pop relies on these being persistent
         keyed elements whose class toggles (a fresh `none → animation` on the
         newly-current dot fires once). If the dots get remounted on each step,
         every dot would pop on every advance. Do not move into the key block. -->
    {#if !isComplete}
      <div style="display: flex; gap: var(--tandem-space-1); margin-bottom: var(--tandem-space-3);">
        {#each Array.from({ length: totalActionable }, (_, i) => i) as i (i)}
          <div
            class="tut-dot"
            class:is-current={i === currentStep}
            style="width: var(--tandem-space-2); height: var(--tandem-space-2); border-radius: var(--tandem-r-circle); background: {i <= currentStep ? 'var(--tandem-accent)' : 'var(--tandem-border)'}; transition: background 0.2s;"
          ></div>
        {/each}
      </div>
    {/if}

    <!-- A22 (#798): panel cross-fade — new step content fades in on advance.
         `in:` only (no `out:`): the new step mounts at full layout height with only
         its opacity animating, so there's no fade-out-then-in height collapse on the
         fixed card. Keyed on step.id so each step is a fresh node. -->
    {#key step.id}
      <div in:fade={{ duration: fadeMs }}>
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
      </div>
    {/key}

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

<style>
  /* A22 (#798): the newly-reached progress dot pops once. A dot fires this only
     when it freshly gains `.is-current` (none → animation), so the monotonic
     stepper pops exactly the just-reached dot — not every dot on every advance. */
  .tut-dot.is-current {
    animation: tutorial-dot-pop 200ms var(--tandem-ease-out);
  }

  @keyframes tutorial-dot-pop {
    0% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.08);
    }
    100% {
      transform: scale(1);
    }
  }

  /* No app-wide reduced-motion catch-all exists — guard both surfaces explicitly. */
  @media (prefers-reduced-motion: reduce) {
    .tut-dot.is-current {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .tut-dot.is-current {
    animation: none;
  }
</style>
