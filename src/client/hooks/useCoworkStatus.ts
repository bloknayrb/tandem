import { useCallback, useEffect, useRef, useState } from "react";
import { COWORK_STATUS_POLL_MS } from "../../shared/constants";
import { coworkGetStatus, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";
import type { CoworkStatus } from "../types";

export interface UseCoworkStatusResult {
  status: CoworkStatus | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Polls `cowork_get_status` every 30s while `active` is true. Stops polling
 * when `active` flips false or on unmount. On error, the error string is
 * surfaced via the returned `error` field and the previous `status` is kept
 * visible (silent-failure-hunter: don't blank the UI on a transient poll
 * failure). Runs as a no-op in non-Tauri environments (e.g. Vite dev).
 */
export function useCoworkStatus(active: boolean): UseCoworkStatusResult {
  const [status, setStatus] = useState<CoworkStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(active);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest Tauri invoke in a ref — the dynamic import only needs
  // to resolve once per mount and subsequent polls reuse it. A `null` value
  // means either the import is still in flight or we're not in Tauri.
  const invokeRef = useRef<InvokeFn | null>(null);
  const tauriMissingRef = useRef<boolean>(false);
  // Guards against setState calls after unmount (strict-mode + dev HMR).
  const mountedRef = useRef<boolean>(true);
  // Held in a ref so refetch() can clear the interval when it detects a
  // non-Tauri environment (the rejection travels through refetch, not through
  // the loadInvoke().catch() chain).
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    if (tauriMissingRef.current) {
      // Not in Tauri — settle into a stable "no status" state so the caller
      // can render its unsupported-runtime branch.
      if (mountedRef.current) setLoading(false);
      return;
    }
    const invoke = invokeRef.current;
    if (!invoke) {
      // Import hasn't resolved yet — the effect below will call refetch
      // again once the invoke is cached.
      return;
    }
    try {
      const next = await coworkGetStatus(invoke);
      if (!mountedRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      // The rejecting stub loadInvoke() returns when Tauri is absent produces
      // this sentinel. Stop polling silently — this is not an error condition.
      if (msg === "Tauri runtime not available") {
        tauriMissingRef.current = true;
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setLoading(false);
        return;
      }
      setError(msg);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Kick off the dynamic import, then start polling once it resolves.
    // loadInvoke() always resolves — Tauri absence is detected inside refetch()
    // when the rejecting stub fires, not here.
    loadInvoke()
      .then((invoke) => {
        if (cancelled) return;
        invokeRef.current = invoke;
        setLoading(true);
        return refetch();
      })
      .catch((err: unknown) => {
        // loadInvoke() itself should never reject, but guard defensively.
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
      });

    intervalRef.current = setInterval(() => {
      if (cancelled) return;
      if (tauriMissingRef.current) return;
      void refetch();
    }, COWORK_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, refetch]);

  return { status, loading, error, refetch };
}
