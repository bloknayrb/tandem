<script lang="ts">
/**
 * Test fixture for `PendingUpdateBanner.svelte` (#1118).
 *
 * Deliberately under `tests/client/fixtures/` and NOT
 * `src/client/svelte-harness/`: `tests/design-system-impl/testid-coverage.test.ts`
 * walks `src/client/` recursively, so a harness placed there is scanned like
 * production markup and its scaffold selectors join the committed contract
 * snapshot (`UpdaterBannerHarness.svelte` contributes `updater-banner-visible`
 * today). A test scaffold should not be a design-system contract.
 */
import type { ComponentProps } from "svelte";
import PendingUpdateBanner from "../../../src/client/components/PendingUpdateBanner.svelte";

// Derived from the component, never re-declared: a hand-copied `Props` here is
// a silent drift channel, because nothing compared it against production until
// #1614 put this file in a typechecked program.
let { visible, onCheck, onDismiss }: ComponentProps<typeof PendingUpdateBanner> =
  $props();
</script>

<PendingUpdateBanner {visible} {onCheck} {onDismiss} />
