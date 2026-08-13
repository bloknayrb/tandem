import type { AutostartStatus } from "../../src/client/tauri/autostart-invoke";

/**
 * A reactive stand-in for `createAutostart`'s `status`.
 *
 * Same reason as [`coworkStatusCell`](./cowork-fixtures.svelte.ts), and the
 * first version of `network-settings-autostart.test.ts` made the mistake that
 * helper warns about: a plain module `let` behind a getter creates no reactive
 * dependency, so `$derived(autostart.status)` in `NetworkSettings.svelte` never
 * invalidates and Svelte's `set_checked` never runs at all.
 *
 * That direction of falseness is the dangerous one. It does not weaken an
 * assertion, it makes a broken component PASS: with the binding inert, a test
 * asserting `box.checked === true` after clicking the box to `true` is
 * satisfied by the click alone, and deleting the production `resyncCheckbox`
 * call leaves it green. Measured — that is exactly what happened here.
 *
 * One cell per module, reset in a FILE-level `beforeEach`.
 */
let current = $state<AutostartStatus>({ enabled: false, trayAvailable: true, error: null });

export const autostartStatusCell = {
  get value(): AutostartStatus {
    return current;
  },
  /** Commit a change the way the OS read-back does: set it, then report it. */
  patch(overrides: Partial<AutostartStatus>): void {
    current = { ...current, ...overrides };
  },
  reset(): void {
    current = { enabled: false, trayAvailable: true, error: null };
  },
};
