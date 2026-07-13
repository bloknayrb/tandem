<script lang="ts">
import { untrack } from "svelte";
import {
  type UseAnnotationReviewParams,
  type UseAnnotationReviewReturn,
  useAnnotationReview,
} from "../panels/useAnnotationReview.svelte.js";

/**
 * Thin mount-only wrapper so `useAnnotationReview` (which uses `onDestroy` +
 * `$state`/`$effect`) runs inside real component-init context. `onReady`
 * hands the hook's return value back to the test so assertions can drive
 * `resolveAnnotation`/`undoResolveAnnotation` directly.
 */
let {
  params,
  onReady,
}: {
  params: UseAnnotationReviewParams;
  onReady: (api: UseAnnotationReviewReturn) => void;
} = $props();

// Deliberate one-shot read at mount: the test harness only ever needs the
// hook's return value once, so this intentionally does NOT track `params`/
// `onReady` as reactive dependencies (silences state_referenced_locally).
const api = untrack(() => useAnnotationReview(params));
untrack(() => onReady(api));
</script>
