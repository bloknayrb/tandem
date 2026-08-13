import type { CoworkStatus } from "../../src/client/types";

/**
 * A `CoworkStatus` in the state the Enable surfaces actually render: Windows,
 * Cowork detected, integration OFF. That is the only combination under which
 * the toggle, the confirm and the pre-flight all exist, so every mounted Cowork
 * suite needs it and they had each written their own nine-field literal.
 *
 * Deliberately a plain `.ts`, split from the reactive cell in
 * `cowork-fixtures.svelte.ts`. `vitest.config.ts` gives the svelte plugin to
 * the `client` project only, so a `.svelte.ts` import from anywhere else in
 * `tests/` fails with `rune_outside_svelte` — in a test that never touches
 * reactivity. Every consumer today is in `tests/client/` and would be fine
 * either way; this is cheap insurance for the first contract or server test
 * that wants a `CoworkStatus`, not a constraint anything currently hits. The
 * alternative — giving the `node` project the svelte plugin — changes the
 * transform pipeline for every server and CLI test to buy the same thing.
 *
 * Import it from HERE, not through the `.svelte.ts`. One symbol, one path.
 *
 * The optional fields are set rather than omitted. Omitting them sends every
 * mounted suite down the `undefined` branch of `undetectedDetail` /
 * `coworkSettingsVariant` at once, so the `blocked` and `noWorkspacesYet` arms
 * are reached by no test — and centralising the omission makes that uniform
 * instead of merely likely. Note this file cannot catch shape DRIFT: no
 * tsconfig covers `tests/` (`tsconfig.json` includes only `src`) and vitest
 * transpiles without checking, so a new required field lands as `undefined`
 * here with nothing to complain. The win is one place to fix, not a guarantee.
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
    claudeDesktopDetected: true,
    // A COUNT, not a flag — `workspacesBlocked?: number`. Zero is "scanned,
    // none blocked", which is what an empty `workspaces` list means here.
    workspacesBlocked: 0,
    workspacesLastScannedAt: null,
    ...overrides,
  };
}
