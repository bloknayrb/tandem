import { onDestroy } from "svelte";
import { COWORK_STATUS_POLL_MS } from "../../shared/constants.js";
import {
  coworkGetStatus,
  type InvokeFn,
  loadInvoke,
  TAURI_NOT_AVAILABLE,
} from "../cowork/cowork-invoke.js";
import type { CoworkStatus } from "../types.js";

export interface CoworkStatusState {
  readonly status: CoworkStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  /**
   * Re-read the OS status. Resolves `true` only when a fresh status was
   * actually stored.
   *
   * The boolean matters because this swallows its own failure into `error`
   * rather than rejecting — so a caller that only `await`s it cannot tell a
   * refreshed `status` from a stale one, and `error` is not a usable substitute
   * (a caller would have to compare it before and after). Anything that reads
   * `status` to decide what to PAINT after a write must gate on this, or it
   * will paint the pre-write value as though it were the outcome.
   * `useFirstRunNeeded`'s `refetch` returns a boolean for the same reason.
   */
  refetch: () => Promise<boolean>;
}

/**
 * Svelte 5 port of `useCoworkStatus`.
 *
 * Polls `cowork_get_status` every 30s while `active` is true. Stops polling
 * when `active` flips false or on destroy. Runs as a no-op in non-Tauri
 * environments (e.g. Vite dev).
 *
 * Accepts a getter for `active` so callers with `$state` values propagate
 * reactively.
 */
export function createCoworkStatus(getActive: () => boolean): CoworkStatusState {
  let status = $state<CoworkStatus | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let invokeRef: InvokeFn | null = null;
  let tauriMissing = false;
  let mounted = true;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  onDestroy(() => {
    mounted = false;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  const refetch = async (): Promise<boolean> => {
    if (tauriMissing) {
      if (mounted) loading = false;
      return false;
    }
    const invoke = invokeRef;
    if (!invoke) return false;
    try {
      const next = await coworkGetStatus(invoke);
      // An unmounted component stored nothing, so this is `false` for the same
      // reason a throw is: `status` does not reflect the read.
      if (!mounted) return false;
      status = next;
      error = null;
      return true;
    } catch (err) {
      if (!mounted) return false;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === TAURI_NOT_AVAILABLE) {
        tauriMissing = true;
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        loading = false;
        return false;
      }
      error = msg;
      return false;
    } finally {
      if (mounted) loading = false;
    }
  };

  $effect(() => {
    const active = getActive();
    if (!active) {
      loading = false;
      return;
    }

    let cancelled = false;

    loadInvoke()
      .then((invoke) => {
        if (cancelled) return;
        invokeRef = invoke;
        loading = true;
        return refetch();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        error = msg;
        loading = false;
      });

    intervalId = setInterval(() => {
      if (cancelled) return;
      if (tauriMissing) return;
      void refetch();
    }, COWORK_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  });

  return {
    get status() {
      return status;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    refetch,
  };
}
