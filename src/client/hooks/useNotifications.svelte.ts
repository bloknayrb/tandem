import { onDestroy } from "svelte";
import { API_NOTIFY_STREAM } from "../../shared/api-paths.js";
import { DEFAULT_MCP_PORT, MAX_VISIBLE_TOASTS, TOAST_DISMISS_MS } from "../../shared/constants.js";
import type { TandemNotification } from "../../shared/types.js";

export interface Toast extends TandemNotification {
  count: number;
}

export interface NotificationsState {
  readonly toasts: Toast[];
  dismiss: (id: string) => void;
}

/**
 * Svelte 5 port of `useNotifications`.
 *
 * Opens an SSE connection to /api/notify-stream and manages a reactive toast list.
 * Auto-dismisses toasts after their configured duration, with dedup support.
 */
export function createNotifications(): NotificationsState {
  let toasts = $state<Toast[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearTimer = (id: string) => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };

  const scheduleDismiss = (id: string, severity: TandemNotification["severity"]) => {
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const ms = TOAST_DISMISS_MS[severity] ?? TOAST_DISMISS_MS.info;
    const timer = setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      timers.delete(id);
    }, ms);
    timers.set(id, timer);
  };

  const dismiss = (id: string) => {
    toasts = toasts.filter((t) => t.id !== id);
    clearTimer(id);
  };

  const url = `http://localhost:${DEFAULT_MCP_PORT}${API_NOTIFY_STREAM}`;
  const es = new EventSource(url);

  es.onmessage = (event) => {
    let notification: TandemNotification;
    try {
      notification = JSON.parse(event.data) as TandemNotification;
    } catch {
      console.warn("[useNotifications] Malformed SSE data:", event.data);
      return;
    }

    // Dedup: if incoming has a dedupKey matching an existing toast, replace and increment count
    if (notification.dedupKey) {
      const existingIdx = toasts.findIndex((t) => t.dedupKey === notification.dedupKey);
      if (existingIdx !== -1) {
        const existing = toasts[existingIdx];
        clearTimer(existing.id);
        const updated: Toast = { ...notification, count: existing.count + 1 };
        const next = [...toasts];
        next[existingIdx] = updated;
        toasts = next;
        scheduleDismiss(updated.id, updated.severity);
        return;
      }
    }

    const newToast: Toast = { ...notification, count: 1 };
    const next = [...toasts, newToast];

    // Enforce max visible toasts — evict oldest
    while (next.length > MAX_VISIBLE_TOASTS) {
      const evicted = next.shift()!;
      clearTimer(evicted.id);
    }

    toasts = next;
    scheduleDismiss(newToast.id, newToast.severity);
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn(
        "[useNotifications] EventSource permanently closed. " +
          "Notifications will not be delivered. Is the server running?",
      );
    }
  };

  onDestroy(() => {
    es.close();
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  });

  return {
    get toasts() {
      return toasts;
    },
    dismiss,
  };
}
