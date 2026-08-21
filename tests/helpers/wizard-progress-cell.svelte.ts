/**
 * A reactive stand-in for the wizard-progress state `IntegrationWizardModal`
 * feeds its `integration-wizard-progress-live` region (#1431).
 *
 * Same reason as [`autostartStatusCell`](./autostart-status-cell.svelte.ts): a
 * plain module `let` behind a getter creates no reactive dependency, so the
 * component's `$derived` never invalidates and the region never changes. Here
 * that falseness runs in the dangerous direction — the test would be asserting
 * that a region *stays* empty, and would pass against a component that had lost
 * the wiring entirely.
 *
 * One cell per module, reset in a FILE-level `beforeEach`.
 */
type Step = "connect" | "applying" | "done" | "error";
type Phase = "idle" | "verifying" | "done";

let step = $state<Step>("connect");
let detecting = $state(false);
let phase = $state<Phase>("idle");

export const wizardProgressCell = {
  get step(): Step {
    return step;
  },
  get detecting(): boolean {
    return detecting;
  },
  get phase(): Phase {
    return phase;
  },
  set(next: { step?: Step; detecting?: boolean; phase?: Phase }): void {
    if (next.step !== undefined) step = next.step;
    if (next.detecting !== undefined) detecting = next.detecting;
    if (next.phase !== undefined) phase = next.phase;
  },
  reset(): void {
    step = "connect";
    detecting = false;
    phase = "idle";
  },
};
