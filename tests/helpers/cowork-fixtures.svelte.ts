import type { CoworkStatus } from "../../src/client/types";

/**
 * A `CoworkStatus` in the state the Enable surfaces actually render: Windows,
 * Cowork detected, integration OFF. That is the only combination under which
 * the toggle, the confirm and the pre-flight all exist, so every mounted Cowork
 * suite needs it and they had each written their own nine-field literal.
 *
 * `CoworkStatus` carries optional fields (`claudeDesktopDetected`,
 * `workspacesBlocked`), so a hand-written literal that omits them typechecks
 * and then quietly stops representing the shape when a required field lands.
 */
export function coworkStatusFixture(overrides: Partial<CoworkStatus> = {}): CoworkStatus {
  return {
    osSupported: true,
    coworkDetected: true,
    enabled: false,
    vethernetCidr: "172.30.16.0/28",
    lanIpFallback: null,
    useLanIpOverride: false,
    workspaces: [],
    uacDeclined: false,
    uacDeclinedAt: null,
    ...overrides,
  };
}

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
 * One cell per module, reset in `beforeEach`. The surfaces under test mount one
 * `CoworkSettings` at a time, so there is nothing to key it by.
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
