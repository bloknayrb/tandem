import { useCallback, useEffect, useRef, useState } from "react";
import { formatCoworkError } from "../cowork/cowork-helpers";
import {
  coworkRetryAdminElevation,
  coworkToggleIntegration,
  type InvokeFn,
  loadInvoke,
} from "../cowork/cowork-invoke";
import { useCoworkStatus } from "../hooks/useCoworkStatus";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Non-dismissable modal rendered globally whenever the Rust side reports a
 * persistent UAC-declined state. The user must either retry elevation or
 * explicitly disable Cowork — there's no close button.
 */
export function CoworkAdminDeclinedModal() {
  const { status, error: statusError, refetch } = useCoworkStatus(true);
  const uacDeclined = status?.uacDeclined === true;

  const modalRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Title badge — surfaces the warning in the OS window/tab list even when
  // the Tandem UI isn't focused. Captures the prior title on mount and
  // restores it when the declined state resolves.
  useEffect(() => {
    if (!uacDeclined) return;
    const prev = typeof document !== "undefined" ? document.title : null;
    if (typeof document !== "undefined" && !document.title.startsWith("\u26a0")) {
      document.title = `\u26a0 ${document.title}`;
    }
    return () => {
      if (typeof document !== "undefined" && prev !== null) {
        document.title = prev;
      }
    };
  }, [uacDeclined]);

  // Focus trap on Tab — standard accessibility pattern.
  useEffect(() => {
    if (!uacDeclined) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !modalRef.current) return;
      const focusables = modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!modalRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [uacDeclined]);

  // Move focus into the modal on open so screen readers announce the
  // heading + the first actionable control is reachable by keyboard.
  useEffect(() => {
    if (!uacDeclined) return;
    modalRef.current?.focus();
  }, [uacDeclined]);

  const withInvoke = useCallback(
    async (op: (invoke: InvokeFn) => Promise<void>, errorPrefix: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const invoke = await loadInvoke();
        await op(invoke);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const display = formatCoworkError(rawMsg);
        if (mountedRef.current) setError(`${errorPrefix}: ${display}`);
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [],
  );

  const handleRetry = useCallback(async (): Promise<void> => {
    await withInvoke(async (invoke) => {
      await coworkRetryAdminElevation(invoke);
      await refetch();
    }, "Retry failed");
  }, [withInvoke, refetch]);

  const handleDisable = useCallback(async (): Promise<void> => {
    await withInvoke(async (invoke) => {
      await coworkToggleIntegration(invoke, false);
      await refetch();
    }, "Failed to disable Cowork");
    setConfirmingDisable(false);
  }, [withInvoke, refetch]);

  // When cowork_get_status itself fails (IPC error, startup race), status stays
  // null and uacDeclined is falsy — the modal would silently not appear. Render
  // a persistent error banner so the user knows something is wrong.
  if (statusError && !status) {
    return (
      <div
        data-testid="cowork-admin-declined-status-error"
        role="alert"
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 10000,
          maxWidth: 400,
          border: "1px solid var(--tandem-error-border)",
          background: "var(--tandem-error-bg)",
          color: "var(--tandem-error-fg-strong)",
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        Cowork status check failed: unable to determine if admin elevation was declined. Please
        restart Tandem to restore normal operation.
      </div>
    );
  }

  if (!uacDeclined) return null;

  return (
    <div
      data-testid="cowork-admin-declined-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.45)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={modalRef}
        data-testid="cowork-admin-declined-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cowork-admin-declined-heading"
        tabIndex={-1}
        style={{
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--tandem-surface)",
          color: "var(--tandem-fg)",
          border: "1px solid var(--tandem-error-border)",
          borderRadius: 8,
          padding: 20,
          boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
          outline: "none",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2
          id="cowork-admin-declined-heading"
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: "var(--tandem-error-fg-strong)",
          }}
        >
          Admin permission required
        </h2>

        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--tandem-fg-muted)" }}>
          Cowork integration requires Windows admin permission to configure firewall rules. Without
          it, Tandem can't safely be reached from inside the Cowork VM. Port 3479 is currently
          blocked by a deny rule to protect your machine.
        </div>

        {error && (
          <div
            data-testid="cowork-admin-declined-error"
            role="alert"
            style={{
              fontSize: 12,
              color: "var(--tandem-error-fg-strong)",
              background: "var(--tandem-error-bg)",
              border: "1px solid var(--tandem-error-border)",
              borderRadius: 4,
              padding: "6px 8px",
            }}
          >
            {error}
          </div>
        )}

        {confirmingDisable ? (
          <div
            data-testid="cowork-admin-declined-confirm-disable"
            style={{
              fontSize: 12,
              color: "var(--tandem-warning-fg-strong)",
              background: "var(--tandem-warning-bg)",
              border: "1px solid var(--tandem-warning-border)",
              borderRadius: 4,
              padding: "8px 10px",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Disable Cowork integration?</div>
            <div style={{ marginBottom: 8 }}>
              The deny rule will remain in place. You can re-enable Cowork later from Settings.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                data-testid="cowork-admin-declined-disable-confirm-btn"
                type="button"
                onClick={() => void handleDisable()}
                disabled={busy}
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  border: "1px solid var(--tandem-error-border)",
                  borderRadius: 4,
                  background: "var(--tandem-error)",
                  color: "var(--tandem-error-fg)",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Disable
              </button>
              <button
                data-testid="cowork-admin-declined-disable-cancel-btn"
                type="button"
                onClick={() => setConfirmingDisable(false)}
                disabled={busy}
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  border: "1px solid var(--tandem-border-strong)",
                  borderRadius: 4,
                  background: "var(--tandem-surface)",
                  color: "var(--tandem-fg-muted)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              data-testid="cowork-admin-declined-disable-btn"
              type="button"
              onClick={() => setConfirmingDisable(true)}
              disabled={busy}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                border: "1px solid var(--tandem-border-strong)",
                borderRadius: 4,
                background: "var(--tandem-surface)",
                color: "var(--tandem-fg-muted)",
                cursor: "pointer",
              }}
            >
              Disable Cowork
            </button>
            <button
              data-testid="cowork-admin-declined-retry-btn"
              type="button"
              onClick={() => void handleRetry()}
              disabled={busy}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                border: "1px solid var(--tandem-accent)",
                borderRadius: 4,
                background: "var(--tandem-accent)",
                color: "var(--tandem-accent-fg)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Retry with admin
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default CoworkAdminDeclinedModal;
