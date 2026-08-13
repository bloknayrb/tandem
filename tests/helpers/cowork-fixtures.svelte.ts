import type { CoworkStatus } from "../../src/client/types";
import { coworkStatusFixture } from "./cowork-status-fixture";

// Deliberately NOT re-exported: `coworkStatusFixture` has one home, and a
// second door here would defeat the split that put it in a plain `.ts`. Import
// it from `./cowork-status-fixture` directly.

/**
 * A reactive stand-in for `createCoworkStatus`'s `status`.
 *
 * `.svelte.ts` and `$state` rather than a plain module `let`, because the real
 * hook's status IS reactive and a frozen one produces a FALSE result, not
 * merely a weak one: with a plain variable, flipping `enabled` in a `refetch`
 * mock never re-renders, `{@const s = coworkState.status}` keeps the stale
 * object, and the toggle's `checked` expression then evaluates against
 * `enabled: false` — so a correct component fails the assertion. Measured;
 * that is exactly what the first version of this helper did.
 *
 * One cell per module, reset in a FILE-level `beforeEach`. Per-describe is not
 * enough: `enableSucceeds()`-style helpers mutate this cell, so a sibling
 * describe inherits whatever the previous one left and its isolation becomes a
 * property of test ordering.
 */
let current = $state(coworkStatusFixture());

export const coworkStatusCell = {
  get value(): CoworkStatus {
    return current;
  },
  /** Commit a change the way the Rust side does: toggle, then report it. */
  patch(overrides: Partial<CoworkStatus>): void {
    current = { ...current, ...overrides };
  },
  reset(): void {
    current = coworkStatusFixture();
  },
};

/**
 * `createCoworkStatus`'s `error`, and reactive for the same reason as the
 * status above.
 *
 * `refetch` sets this instead of throwing, so the surface's error banner is the
 * only thing that can report a failed re-read. A frozen `let` here makes that
 * banner untestable in the direction that matters — it can never appear, so a
 * test asserting it does will fail against correct code.
 */
let currentError = $state<string | null>(null);

export const coworkErrorCell = {
  get value(): string | null {
    return currentError;
  },
  set(next: string | null): void {
    currentError = next;
  },
  reset(): void {
    currentError = null;
  },
};
