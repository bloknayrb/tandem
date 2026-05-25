<script lang="ts">
import { untrack } from "svelte";
import { createNotifications, type NotificationsState } from "../hooks/useNotifications.svelte";

interface Props {
  onReady: (state: NotificationsState) => void;
  // Persistence defaults OFF so the harness never clobbers the real app's
  // ACTIVITY_HISTORY_KEY. A test that needs rehydrate/re-arm coverage opts in
  // with an isolated storageKey (see plan-review).
  persist?: boolean;
  storageKey?: string;
}

let { onReady, persist = false, storageKey }: Props = $props();

// The store is created once at mount; untrack reads the props' initial values
// intentionally (silences `state_referenced_locally` — there is no reactive
// re-creation to wire up here).
const notifications = untrack(() => createNotifications({ persist, storageKey }));
$effect(() => {
  onReady(notifications);
});
</script>

<div data-testid="notifications-harness">
  {#each notifications.toasts as toast (toast.id)}
    <div data-testid="toast" data-dedup-key={toast.dedupKey ?? ""} data-count={toast.count}>
      {toast.message}
    </div>
  {/each}
</div>
