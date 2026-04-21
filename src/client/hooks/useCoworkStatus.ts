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
      setError(err instanceof Error ? err.message : String(err));
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
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Kick off the dynamic import, then start polling once it resolves.
    loadInvoke()
      .then((invoke) => {
        if (cancelled) return;
        // `loadInvoke` returns a rejecting stub when Tauri is absent; detect
        // that by doing one probe call and marking the runtime missing if it
        // throws with our sentinel message.
        invokeRef.current = invoke;
        setLoading(true);
        return refetch();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Tauri runtime not available")) {
          tauriMissingRef.current = true;
        } else {
          setError(msg);
        }
        setLoading(false);
      });

    intervalId = setInterval(() => {
      if (cancelled) return;
      if (tauriMissingRef.current) return;
      void refetch();
    }, COWORK_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [active, refetch]);

  return { status, loading, error, refetch };
}
