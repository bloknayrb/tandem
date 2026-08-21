import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import { requestUpdateCheck, wirePendingUpdateHint } from "@client/utils/pending-update-hint.js";

/**
 * #1118: state for the "your update may not have completed" banner.
 *
 * All of the logic worth testing lives in `utils/pending-update-hint.ts`; this
 * is the `$state` glue, kept as a hook rather than inline in `App.svelte` so the
 * banner's own wiring is reachable from a component test.
 *
 * Non-Tauri environments still construct the hook (the wiring is simply skipped)
 * so the consumer surface is identical across runtimes — the same shape
 * `createUpdaterBanner` uses. `showBanner` just stays `false` in a browser.
 */
export interface PendingUpdateBannerState {
  /** True iff the banner should render right now. */
  readonly showBanner: boolean;
  /** Dismiss without acting. */
  dismiss: () => void;
  /** "Check for updates" — dismisses AND asks the shell to re-check. */
  check: () => void;
}

const loadCore = () => import("@tauri-apps/api/core");
const loadEvent = () => import("@tauri-apps/api/event");

export function createPendingUpdateBanner(): PendingUpdateBannerState {
  let message = $state<string | null>(null);

  $effect(() => {
    if (!isTauriRuntime()) return;
    // Written from an async callback wired inside an $effect — the same shape as
    // the adjacent banner hooks, and not the Tiptap-transaction shape that
    // `state_unsafe_mutation` punishes.
    return wirePendingUpdateHint({
      loadCore,
      loadEvent,
      onHint: (m) => {
        message = m;
      },
    });
  });

  return {
    get showBanner() {
      return message !== null;
    },
    dismiss() {
      message = null;
    },
    check() {
      // Dismiss first: the CTA's feedback is a native dialog from the shell, and
      // leaving the banner up behind it would read as "the click did nothing".
      message = null;
      void requestUpdateCheck(loadCore);
    },
  };
}
