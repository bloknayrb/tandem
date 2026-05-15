<script lang="ts">
import { createNotifications, type NotificationsState } from "../hooks/useNotifications.svelte";

interface Props {
  onReady: (state: NotificationsState) => void;
}

let { onReady }: Props = $props();

const notifications = createNotifications();
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
