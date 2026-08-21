/**
 * A reactive stand-in for `createIntegrationWizard`'s `step`.
 *
 * Same reason as [`autostartStatusCell`](./autostart-status-cell.svelte.ts),
 * and `integration-wizard-push-support.test.ts` had made precisely the mistake
 * that helper warns about: its mock returned `step: "done"` as a frozen literal
 * while one test wrote `wizardStub.step`, a field nothing read. TypeScript
 * would have caught it, but `tests/` sits outside every tsconfig.
 *
 * The consequence was the dangerous direction. "Does not carry a copy status
 * through a retry" was written to prove the push-routes block UNMOUNTS on
 * `wizard.reset()` and remounts clean — its comment says so — but with `step`
 * frozen the block never unmounted, so what it actually measured was the
 * wizard's manual `pluginCopyResult = ""` line. #1432 moved that state into
 * `PushRoutesInfo`, where the unmount IS the reset; the test went red not
 * because the behaviour regressed but because it had never been exercising the
 * mechanism it described.
 *
 * One cell per module, reset in a file-level `afterEach`.
 */
let current = $state<string>("done");

export const wizardStepCell = {
  get value(): string {
    return current;
  },
  set(next: string): void {
    current = next;
  },
  reset(): void {
    current = "done";
  },
};
