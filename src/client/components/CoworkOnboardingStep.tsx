import { useCallback, useEffect, useRef, useState } from "react";
import { firewallErrorHint, writeCoworkOnboardingSkipped } from "../cowork/cowork-helpers";
import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";
import type { CoworkStatus, FirewallErrorVariant } from "../types";

export interface CoworkOnboardingStepProps {
  /** The current `cowork_get_status` snapshot — used to show the detected subnet. */
  status: CoworkStatus;
  /** Called after the user completes (Enable or Skip) — advances the tutorial. */
  onAdvance: () => void;
  /** Called when the user clicks "Learn more" — does not advance the step. */
  onLearnMore?: () => void;
}

/**
 * Rendered inline inside `OnboardingTutorial` when the Rust side reports
 * `osSupported && coworkDetected && !enabled`. The parent tutorial is
 * responsible for gating visibility — this component only renders its own
 * UI and delegates advancement via `onAdvance`.
 */
export function CoworkOnboardingStep({
  status,
  onAdvance,
  onLearnMore,
}: CoworkOnboardingStepProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const withInvoke = useCallback(
    async (op: (invoke: InvokeFn) => Promise<void>, errorPrefix: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const invoke = await loadInvoke();
        await op(invoke);
        return true;
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        let display = rawMsg;
        try {
          const parsed = JSON.parse(rawMsg) as { kind?: string };
          if (parsed.kind) {
            display = firewallErrorHint(parsed as FirewallErrorVariant);
          }
        } catch {
          // not JSON — use raw message
        }
        if (mountedRef.current) setError(`${errorPrefix}: ${display}`);
        return false;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [],
  );

  const handleEnable = useCallback(async (): Promise<void> => {
    const ok = await withInvoke(async (invoke) => {
      await coworkToggleIntegration(invoke, true);
    }, "Failed to enable Cowork");
    if (ok) onAdvance();
  }, [withInvoke, onAdvance]);

  const handleSkip = useCallback((): void => {
    writeCoworkOnboardingSkipped();
    onAdvance();
  }, [onAdvance]);

  return (
    <div
      data-testid="cowork-onboarding-step"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--tandem-fg)",
        }}
      >
        Claude Desktop Cowork detected
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--tandem-fg-muted)",
        }}
      >
        Enable Tandem inside Cowork workspaces?
        {status.vethernetCidr !== null && (
          <>
            {" "}
            Detected VM subnet: <code>{status.vethernetCidr}</code>.
          </>
        )}
      </div>

      {error && (
        <div
          data-testid="cowork-onboarding-error"
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

      {confirming ? (
        <div
          data-testid="cowork-onboarding-confirm"
          style={{
            fontSize: 12,
            color: "var(--tandem-warning-fg-strong)",
            background: "var(--tandem-warning-bg)",
            border: "1px solid var(--tandem-warning-border)",
            borderRadius: 4,
            padding: "8px 10px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Confirm: Enable Cowork</div>
          <div style={{ marginBottom: 8 }}>
            Windows will prompt for admin permission to modify firewall rules. This is expected.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="cowork-onboarding-enable-confirm-btn"
              type="button"
              onClick={() => void handleEnable()}
              disabled={busy}
              style={primaryBtnStyle}
            >
              Enable
            </button>
            <button
              data-testid="cowork-onboarding-enable-cancel-btn"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              style={secondaryBtnStyle}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            data-testid="cowork-onboarding-enable-btn"
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            style={primaryBtnStyle}
          >
            Enable
          </button>
          <button
            data-testid="cowork-onboarding-skip-btn"
            type="button"
            onClick={handleSkip}
            disabled={busy}
            style={secondaryBtnStyle}
          >
            Skip
          </button>
          {onLearnMore ? (
            <button
              data-testid="cowork-onboarding-learn-more-btn"
              type="button"
              onClick={onLearnMore}
              disabled={busy}
              style={secondaryBtnStyle}
            >
              Learn more
            </button>
          ) : (
            <a
              data-testid="cowork-onboarding-learn-more-link"
              href="https://github.com/bloknayrb/tandem#cowork"
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 12,
                color: "var(--tandem-accent)",
                alignSelf: "center",
                textDecoration: "underline",
              }}
            >
              Learn more
            </a>
          )}
        </div>
      )}
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  border: "1px solid var(--tandem-accent)",
  borderRadius: 4,
  background: "var(--tandem-accent)",
  color: "var(--tandem-accent-fg)",
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  border: "1px solid var(--tandem-border-strong)",
  borderRadius: 4,
  background: "var(--tandem-surface)",
  color: "var(--tandem-fg-muted)",
  cursor: "pointer",
};

export default CoworkOnboardingStep;
