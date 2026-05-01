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
  refetch: () => Promise<void>;
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

  const refetch = async (): Promise<void> => {
    if (tauriMissing) {
      if (mounted) loading = false;
      return;
    }
    const invoke = invokeRef;
    if (!invoke) return;
    try {
      const next = await coworkGetStatus(invoke);
      if (!mounted) return;
      status = next;
      error = null;
    } catch (err) {
      if (!mounted) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === TAURI_NOT_AVAILABLE) {
        tauriMissing = true;
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        loading = false;
        return;
      }
      error = msg;
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
