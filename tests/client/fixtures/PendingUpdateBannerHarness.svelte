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
import PendingUpdateBanner from "../../../src/client/components/PendingUpdateBanner.svelte";

interface Props {
  visible: boolean;
  onCheck: () => void;
  onDismiss: () => void;
}

let { visible, onCheck, onDismiss }: Props = $props();
</script>

<PendingUpdateBanner {visible} {onCheck} {onDismiss} />
