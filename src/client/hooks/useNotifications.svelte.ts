import { onDestroy } from "svelte";
import { API_NOTIFY_STREAM } from "../../shared/api-paths.js";
import {
  ACTIVITY_HISTORY_CAP,
  ACTIVITY_HISTORY_KEY,
  ACTIVITY_INFO_TTL_MS,
  MAX_VISIBLE_TOASTS,
  TOAST_DISMISS_MS,
} from "../../shared/constants.js";
import type { TandemNotification } from "../../shared/types.js";
import { MCP_BASE_URL } from "../utils/backend-ports.js";

/**
 * An optional action button on a transient toast (#1018). CLIENT-ONLY and
 * NEVER serialized: it carries a function, so it must stay off the persisted
 * `TandemNotification`/`ActivityItem` (which round-trip through JSON for SSE +
 * localStorage) and off the `dedupKey` identity. Lives on `Toast` alone.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /**
   * Keep the toast until its action is pressed or it is closed (#1123). Read
   * from the toast's CURRENT action, so a coalescing re-push without it stops
   * staying. A staying toast arms no pop timer, survives the info TTL (its tray
   * row does not), and is evicted past the cap only when no other toast lacks
   * the flag. Client-only like the rest of this type.
   */
  stay?: boolean;
}

export interface Toast extends TandemNotification {
  count: number;
  action?: ToastAction;
}

/**
 * A persisted activity-tray entry. Mirrors a notification plus a coalesce
 * `count`. Unlike a transient `Toast`, a coalesced activity item keeps its
 * FIRST `id` stable (see `coalesceActivity`) so `activity-row-{id}` testids,
 * the keyed `{#each}`, and the localStorage record don't churn on every repeat.
 */
export interface ActivityItem extends TandemNotification {
  count: number;
}

/**
 * Which toast each of the toast stack's two announcers speaks (#2489): the id
 * of the toast whose push (or coalescing re-push) came last at that
 * politeness, or null before any. `polite` takes info, `assertive` warning and
 * error, matching the roles the cards used to carry.
 *
 * Ids, not sentences, on purpose: `ToastContainer` looks the id up in the
 * CURRENT `toasts` and speaks nothing once that toast is gone. So a dismissed,
 * expired or evicted toast empties its announcer (a removal, which no screen
 * reader speaks) instead of letting an older toast's sentence slide back in
 * (an addition, which would be spoken as if new). Written only by a push,
 * never by a removal, so no removal path needs to remember it.
 */
export interface ToastAnnouncement {
  readonly polite: string | null;
  readonly assertive: string | null;
}

export interface NotificationsState {
  /** Transient pop toasts (warning/error always; client-originated info too). */
  readonly toasts: Toast[];
  /** The toast each announcer speaks; see `ToastAnnouncement`. */
  readonly announced: ToastAnnouncement;
  /** Persistent activity-tray history (all severities, localStorage-backed). */
  readonly activity: ActivityItem[];
  /** Non-dismissed activity count — drives the pill badge. */
  readonly total: number;
  /** Dismiss a transient pop (the item remains in the tray). */
  dismiss: (id: string) => void;
  /** Remove an item from the activity tray. */
  dismissActivity: (id: string) => void;
  /** Empty the activity tray. */
  clearActivity: () => void;
  /**
   * Surface a CLIENT-originated notification (not delivered via SSE). Use for
   * user-action echoes and client errors. Info pushed here POPS briefly (it's a
   * message to the user) and also lands in the tray — vs ambient SSE info, which
   * is quiet (tray only). See the entry-point gating note below.
   */
  push: (notification: TandemNotification, action?: ToastAction) => void;
}

interface CreateOpts {
  /** Persist the activity tray to localStorage. Default true; the test harness
   *  passes false so it never clobbers the real app's `ACTIVITY_HISTORY_KEY`. */
  persist?: boolean;
  storageKey?: string;
  /**
   * Called for every notice that arrives on the notify stream (after the
   * replay dedupe), from the stream's own message handler — an event handler,
   * never inside a reaction. App uses it to re-read who answers chat when the
   * switch's own notices arrive (#1123 part B, R1.2).
   */
  onStreamNotice?: (notification: TandemNotification) => void;
  /**
   * Called each time the notify stream (re)opens, from its `open` handler.
   * Notices pushed while it was down are not replayed to `onStreamNotice`, so
   * a consumer deriving state from them re-reads it here (ADR-057 PR 2: the
   * kept-edits banner).
   */
  onStreamOpen?: () => void;
}

const INFO_TTL = ACTIVITY_INFO_TTL_MS;
const SAVE_DEBOUNCE_MS = 250;

function isInfoExpired(item: TandemNotification, now: number): boolean {
  return item.severity === "info" && now - item.timestamp >= INFO_TTL;
}

/** Defensive localStorage read: tolerate malformed data, prune expired info + cap.
 *  Exported for unit testing the rehydrate/prune logic. */
export function loadActivity(storageKey: string): ActivityItem[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const items = parsed.filter(
      (x): x is ActivityItem =>
        x !== null &&
        typeof x === "object" &&
        typeof (x as ActivityItem).id === "string" &&
        typeof (x as ActivityItem).message === "string" &&
        typeof (x as ActivityItem).timestamp === "number" &&
        // Severity drives glyph/class/pill lookups — a missing or out-of-range
        // value would render an unstyled, glyph-less row the pill never counts.
        ["info", "warning", "error"].includes((x as ActivityItem).severity),
    );
    // On reload the in-memory info-TTL timers are gone, so re-evaluate here:
    // drop info older than its TTL, then cap to the newest ACTIVITY_HISTORY_CAP.
    return items.filter((i) => !isInfoExpired(i, now)).slice(-ACTIVITY_HISTORY_CAP);
  } catch (err) {
    console.warn("[useNotifications] failed to load activity history:", err);
    return [];
  }
}

/**
 * Svelte 5 notification store + activity center.
 *
 * Two surfaces fed from one ingest:
 *  - `toasts` — transient pops (auto-dismiss, max-visible eviction).
 *  - `activity` — persistent tray history (localStorage, coalesced, capped).
 *
 * Info-pop gating is by ENTRY POINT, not a per-notification flag: client
 * `push()` calls are messages-to-the-user (echoes/errors) so their info pops;
 * SSE `onmessage` info is ambient so it stays quiet (tray only). Warning/error
 * always pop regardless of source.
 */
export function createNotifications(opts: CreateOpts = {}): NotificationsState {
  const persist = opts.persist ?? true;
  const storageKey = opts.storageKey ?? ACTIVITY_HISTORY_KEY;

  let toasts = $state<Toast[]>([]);
  let announced = $state<ToastAnnouncement>({ polite: null, assertive: null });
  let activity = $state<ActivityItem[]>(persist ? loadActivity(storageKey) : []);

  const popTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const infoTtlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let saveHandle: ReturnType<typeof setTimeout> | null = null;

  // ---- persistence (imperative, debounced — never in an $effect) ----
  const flushSave = () => {
    if (!persist) return;
    saveHandle = null;
    try {
      localStorage.setItem(storageKey, JSON.stringify(activity));
    } catch {
      // incognito / quota — drop silently; the tray still works in-memory.
    }
  };
  const scheduleSave = () => {
    if (!persist) return;
    if (saveHandle) clearTimeout(saveHandle);
    saveHandle = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  };

  // ---- transient pop list ----
  const clearPopTimer = (id: string) => {
    const t = popTimers.get(id);
    if (t) {
      clearTimeout(t);
      popTimers.delete(id);
    }
  };
  const schedulePopDismiss = (id: string, severity: TandemNotification["severity"]) => {
    clearPopTimer(id);
    const ms = TOAST_DISMISS_MS[severity] ?? TOAST_DISMISS_MS.info;
    popTimers.set(
      id,
      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== id);
        popTimers.delete(id);
      }, ms),
    );
  };

  // A coalescing re-push can keep its id and change severity (info → error):
  // the other announcer then still names that id and would speak it too, so
  // it is cleared rather than left pointing at a toast now spoken elsewhere.
  const announce = (toast: Toast) => {
    const info = toast.severity === "info";
    const other = (id: string | null) => (id === toast.id ? null : id);
    announced = info
      ? { polite: toast.id, assertive: other(announced.assertive) }
      : { polite: other(announced.polite), assertive: toast.id };
  };

  const pushTransient = (notification: TandemNotification, action?: ToastAction) => {
    if (notification.dedupKey) {
      const idx = toasts.findIndex((t) => t.dedupKey === notification.dedupKey);
      if (idx !== -1) {
        const existing = toasts[idx];
        clearPopTimer(existing.id);
        // action is NOT part of dedup identity; the latest push's action wins.
        const updated: Toast = { ...notification, count: existing.count + 1, action };
        const next = [...toasts];
        next[idx] = updated;
        toasts = next;
        announce(updated);
        if (updated.action?.stay !== true) schedulePopDismiss(updated.id, updated.severity);
        return;
      }
    }
    const newToast: Toast = { ...notification, count: 1, action };
    const next = [...toasts, newToast];
    while (next.length > MAX_VISIBLE_TOASTS) {
      // The oldest non-staying toast, never counting the one just pushed
      // (the last); if every other toast stays, the oldest, as before.
      const i = next.findIndex((t, k) => k < next.length - 1 && t.action?.stay !== true);
      const [evicted] = next.splice(i === -1 ? 0 : i, 1);
      clearPopTimer(evicted.id);
    }
    toasts = next;
    announce(newToast);
    if (newToast.action?.stay !== true) schedulePopDismiss(newToast.id, newToast.severity);
  };

  // ---- persistent activity list ----
  const clearInfoTimer = (id: string) => {
    const existing = infoTtlTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      infoTtlTimers.delete(id);
    }
  };
  const scheduleInfoExpiry = (id: string, timestamp: number) => {
    clearInfoTimer(id);
    const remaining = Math.max(0, INFO_TTL - (Date.now() - timestamp));
    infoTtlTimers.set(
      id,
      setTimeout(() => {
        infoTtlTimers.delete(id);
        // Presence-check before mutating (guards a late timer post-destroy).
        if (!activity.some((a) => a.id === id)) return;
        activity = activity.filter((a) => a.id !== id);
        // The tray row goes; a toast whose action stays is kept until closed.
        toasts = toasts.filter((t) => t.id !== id || t.action?.stay === true);
        scheduleSave();
      }, remaining),
    );
  };

  const coalesceActivity = (notification: TandemNotification) => {
    if (notification.dedupKey) {
      const idx = activity.findIndex((a) => a.dedupKey === notification.dedupKey);
      if (idx !== -1) {
        const existing = activity[idx];
        // Keep the FIRST id (stable testids / keyed-each / storage) and its
        // list position; bump count + refresh timestamp so the relative-time
        // label ages from the latest hit and the info-expiry timer re-arms.
        const updated: ActivityItem = {
          ...notification,
          id: existing.id,
          count: existing.count + 1,
        };
        const next = [...activity];
        next[idx] = updated;
        activity = next;
        if (updated.severity === "info") {
          scheduleInfoExpiry(updated.id, updated.timestamp);
        } else {
          // Severity upgraded away from info (e.g. info→error on the same
          // dedupKey): drop the stale info-expiry timer so it can't later
          // delete the now-persistent warning/error row out from under us.
          clearInfoTimer(updated.id);
        }
        scheduleSave();
        return;
      }
    }
    const item: ActivityItem = { ...notification, count: 1 };
    const next = [...activity, item];
    while (next.length > ACTIVITY_HISTORY_CAP) next.shift();
    activity = next;
    if (item.severity === "info") scheduleInfoExpiry(item.id, item.timestamp);
    scheduleSave();
  };

  /** Shared fan-out. `popInfo` decides whether an info item also pops.
   *  `action` (client-push only) rides on the transient toast, never the
   *  persisted activity item (it's a non-serializable function). */
  const ingest = (notification: TandemNotification, popInfo: boolean, action?: ToastAction) => {
    coalesceActivity(notification);
    const shouldPop = notification.severity !== "info" || popInfo;
    if (shouldPop) pushTransient(notification, action);
  };

  // ---- public API ----
  const dismiss = (id: string) => {
    toasts = toasts.filter((t) => t.id !== id);
    clearPopTimer(id);
  };

  const dismissActivity = (id: string) => {
    activity = activity.filter((a) => a.id !== id);
    clearInfoTimer(id);
    scheduleSave();
  };

  const clearActivity = () => {
    activity = [];
    for (const t of infoTtlTimers.values()) clearTimeout(t);
    infoTtlTimers.clear();
    scheduleSave();
  };

  // Re-arm info-expiry for items rehydrated from localStorage — in-memory
  // timers don't survive a reload, so without this a within-TTL info entry
  // would linger in the tray indefinitely instead of expiring on schedule.
  for (const item of activity) {
    if (item.severity === "info") scheduleInfoExpiry(item.id, item.timestamp);
  }

  // Client-originated: info pops (it's a message to the user). An optional
  // action button is client-only (off the wire / off the persisted tray).
  const push = (notification: TandemNotification, action?: ToastAction) =>
    ingest(notification, true, action);

  // ---- SSE: ambient, info stays quiet ----
  const url = `${MCP_BASE_URL}${API_NOTIFY_STREAM}`;
  const es = new EventSource(url);

  // The server replays its startup notices to every stream that connects
  // (src/server/startup-notices.ts), and EventSource reconnects on its own after
  // a sleep or a network blip. A replayed notice keeps its id, so an id this page
  // has already ingested, or already holds in the persisted tray, is the same
  // notice again: without this it would re-toast and bump the tray count on
  // every reconnect. Live pushes carry a fresh id each, so they never match.
  const seenStreamIds = new Set<string>(activity.map((a) => a.id));

  es.onmessage = (event) => {
    let notification: TandemNotification;
    try {
      notification = JSON.parse(event.data) as TandemNotification;
    } catch {
      console.warn("[useNotifications] Malformed SSE data:", event.data);
      return;
    }
    if (seenStreamIds.has(notification.id)) return;
    seenStreamIds.add(notification.id);
    ingest(notification, false);
    try {
      opts.onStreamNotice?.(notification);
    } catch (err) {
      console.warn("[useNotifications] onStreamNotice failed", err);
    }
  };

  es.onopen = () => {
    try {
      opts.onStreamOpen?.();
    } catch (err) {
      console.warn("[useNotifications] onStreamOpen failed", err);
    }
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
    for (const timer of popTimers.values()) clearTimeout(timer);
    popTimers.clear();
    for (const timer of infoTtlTimers.values()) clearTimeout(timer);
    infoTtlTimers.clear();
    // Flush the pending debounced write so the last burst survives reload.
    if (saveHandle) {
      clearTimeout(saveHandle);
      flushSave();
    }
  });

  return {
    get toasts() {
      return toasts;
    },
    get announced() {
      return announced;
    },
    get activity() {
      return activity;
    },
    get total() {
      return activity.length;
    },
    dismiss,
    dismissActivity,
    clearActivity,
    push,
  };
}
