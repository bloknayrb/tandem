import type { CoworkStatus } from "../../src/client/types";

/**
 * A `CoworkStatus` in the state the Enable surfaces actually render: Windows,
 * Cowork detected, integration OFF. That is the only combination under which
 * the toggle, the confirm and the pre-flight all exist, so every mounted Cowork
 * suite needs it and they had each written their own nine-field literal.
 *
 * Deliberately a plain `.ts`, split from the reactive cell in
 * `cowork-fixtures.svelte.ts`. Measured, not assumed: importing a `.svelte.ts`
 * from a `tests/` file outside `tests/client/` fails with `ReferenceError:
 * $state is not defined` — in a test that never touches reactivity. Note
 * `vitest.config.ts` DOES declare the svelte plugin at the root as well as on
 * the `client` project; the root declaration simply does not reach the `node`
 * project's transform, which is why the split is about where a file lives
 * rather than about the config growing a plugin.
 *
 * Every consumer today is in `tests/client/` and would be fine either way; this
 * is cheap insurance for the first contract or server test that wants a
 * `CoworkStatus`, not a constraint anything currently hits. The alternative —
 * giving the `node` project the svelte plugin — changes the transform pipeline
 * for every server and CLI test to buy the same thing.
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
