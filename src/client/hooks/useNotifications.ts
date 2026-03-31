import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_MCP_PORT, MAX_VISIBLE_TOASTS, TOAST_DISMISS_MS } from "../../shared/constants";
import type { TandemNotification } from "../../shared/types";

export interface Toast extends TandemNotification {
  /** Number of times this dedup key has been seen (1 = first occurrence). */
  count: number;
}

export function useNotifications(): {
  toasts: Toast[];
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Schedule auto-dismiss for a toast
  const scheduleDismiss = useCallback((id: string, severity: TandemNotification["severity"]) => {
    // Clear any existing timer for this id before setting a new one
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);

    const ms = TOAST_DISMISS_MS[severity] ?? TOAST_DISMISS_MS.info;
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, ms);
    timersRef.current.set(id, timer);
  }, []);

  /** Clear a timer by toast ID, removing it from the ref map. */
  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      clearTimer(id);
    },
    [clearTimer],
  );

  useEffect(() => {
    const url = `http://localhost:${DEFAULT_MCP_PORT}/api/notify-stream`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      let notification: TandemNotification;
      try {
        notification = JSON.parse(event.data) as TandemNotification;
      } catch {
        console.warn("[useNotifications] Malformed SSE data:", event.data);
        return;
      }

      setToasts((prev) => {
        // Dedup: if incoming has a dedupKey matching an existing toast, replace and increment count
        if (notification.dedupKey) {
          const existingIdx = prev.findIndex((t) => t.dedupKey === notification.dedupKey);
          if (existingIdx !== -1) {
            const existing = prev[existingIdx];
            // Clear old toast's timer before replacing
            clearTimer(existing.id);
            const updated: Toast = {
              ...notification,
              count: existing.count + 1,
            };
            const next = [...prev];
            next[existingIdx] = updated;
            scheduleDismiss(updated.id, updated.severity);
            return next;
          }
        }

        const newToast: Toast = { ...notification, count: 1 };
        const next = [...prev, newToast];

        // Enforce max visible toasts — evict oldest
        while (next.length > MAX_VISIBLE_TOASTS) {
          const evicted = next.shift()!;
          clearTimer(evicted.id);
        }

        scheduleDismiss(newToast.id, newToast.severity);
        return next;
      });
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        console.warn(
          "[useNotifications] EventSource permanently closed. " +
            "Notifications will not be delivered. Is the server running?",
        );
      }
    };

    return () => {
      es.close();
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, [scheduleDismiss, clearTimer]);

  return { toasts, dismiss };
}
