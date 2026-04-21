import { useCallback, useEffect, useRef, useState } from "react";
import { COWORK_RESCAN_DEBOUNCE_MS } from "../../shared/constants";
import {
  aggregateWorkspaceStatus,
  coworkSettingsVariant,
  makeDebouncer,
  type StatusTokenFamily,
  workspaceFileStatusFamily,
  workspaceFileStatusLabel,
} from "../cowork/cowork-helpers";
import {
  coworkRescan,
  coworkSetLanIpOverride,
  coworkToggleIntegration,
  type InvokeFn,
  loadInvoke,
} from "../cowork/cowork-invoke";
import { useCoworkStatus } from "../hooks/useCoworkStatus";
import type { CoworkStatus, WorkspaceFileStatus, WorkspaceStatus } from "../types";

const STATUS_TOKENS: Record<StatusTokenFamily, { bg: string; fg: string; border: string }> = {
  success: {
    bg: "var(--tandem-success-bg)",
    fg: "var(--tandem-success-fg-strong)",
    border: "var(--tandem-success-border)",
  },
  warning: {
    bg: "var(--tandem-warning-bg)",
    fg: "var(--tandem-warning-fg-strong)",
    border: "var(--tandem-warning-border)",
  },
  error: {
    bg: "var(--tandem-error-bg)",
    fg: "var(--tandem-error-fg-strong)",
    border: "var(--tandem-error-border)",
  },
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--tandem-fg)",
  marginBottom: "6px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const helpTextStyle: React.CSSProperties = {
  fontSize: "10px",
  color: "var(--tandem-fg-subtle)",
  marginTop: "4px",
};

interface InlineToast {
  message: string;
  severity: "error" | "info";
}

export function CoworkSettings() {
  const { status, loading, error, refetch } = useCoworkStatus(true);
  const [inlineToast, setInlineToast] = useState<InlineToast | null>(null);
  const [confirming, setConfirming] = useState<"enable" | null>(null);
  const [busy, setBusy] = useState(false);

  const debouncerRef = useRef(makeDebouncer(COWORK_RESCAN_DEBOUNCE_MS));
  useEffect(() => () => debouncerRef.current.cancel(), []);

  const withInvoke = useCallback(
    async (op: (invoke: InvokeFn) => Promise<void>, errorPrefix: string): Promise<void> => {
      setBusy(true);
      try {
        const invoke = await loadInvoke();
        await op(invoke);
        setInlineToast(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInlineToast({ message: `${errorPrefix}: ${msg}`, severity: "error" });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleToggleOn = useCallback(async (): Promise<void> => {
    await withInvoke(async (invoke) => {
      await coworkToggleIntegration(invoke, true);
      await refetch();
    }, "Failed to enable Cowork");
    setConfirming(null);
  }, [withInvoke, refetch]);

  const handleToggleOff = useCallback(async (): Promise<void> => {
    await withInvoke(async (invoke) => {
      await coworkToggleIntegration(invoke, false);
      await refetch();
    }, "Failed to disable Cowork");
  }, [withInvoke, refetch]);

  const handleRescan = useCallback((): void => {
    debouncerRef.current.schedule(() => {
      void withInvoke(async (invoke) => {
        await coworkRescan(invoke);
        await refetch();
      }, "Re-scan failed");
    });
  }, [withInvoke, refetch]);

  const handleToggleLanIp = useCallback(
    async (enabled: boolean): Promise<void> => {
      await withInvoke(async (invoke) => {
        await coworkSetLanIpOverride(invoke, enabled);
        await refetch();
      }, "Failed to update LAN-IP override");
    },
    [withInvoke, refetch],
  );

  const variant = coworkSettingsVariant(status);

  return (
    <div
      data-testid="cowork-settings"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={sectionLabelStyle}>Cowork Integration</div>

      {loading && <LoadingState />}
      {!loading && variant === "unsupported" && <UnsupportedOsState />}
      {!loading && variant === "undetected" && <UndetectedState />}
      {!loading && variant === "normal" && status !== null && (
        <NormalState
          status={status}
          busy={busy}
          confirming={confirming}
          onRequestEnable={() => setConfirming("enable")}
          onCancelEnable={() => setConfirming(null)}
          onConfirmEnable={handleToggleOn}
          onDisable={handleToggleOff}
          onRescan={handleRescan}
          onToggleLanIp={handleToggleLanIp}
        />
      )}

      {error && !status && (
        <div data-testid="cowork-settings-error" role="alert" style={errorBannerStyle}>
          Failed to load Cowork status: {error}
        </div>
      )}

      {inlineToast && (
        <div
          data-testid="cowork-inline-toast"
          role={inlineToast.severity === "error" ? "alert" : "status"}
          style={errorBannerStyle}
        >
          {inlineToast.message}
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      data-testid="cowork-settings-loading"
      style={{ fontSize: 12, color: "var(--tandem-fg-subtle)" }}
    >
      Loading Cowork status...
    </div>
  );
}

function UnsupportedOsState() {
  return (
    <div data-testid="cowork-settings-unsupported" style={infoBannerStyle}>
      Cowork integration is available on Windows in v0.8.0. macOS/Linux support tracked in #316 /
      #317.
    </div>
  );
}

function UndetectedState() {
  return (
    <div data-testid="cowork-settings-undetected" style={infoBannerStyle}>
      Cowork not detected on this system.{" "}
      <a
        href="https://github.com/bloknayrb/tandem#cowork"
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--tandem-accent)" }}
      >
        Learn more
      </a>
    </div>
  );
}

interface NormalStateProps {
  status: CoworkStatus;
  busy: boolean;
  confirming: "enable" | null;
  onRequestEnable: () => void;
  onCancelEnable: () => void;
  onConfirmEnable: () => Promise<void>;
  onDisable: () => Promise<void>;
  onRescan: () => void;
  onToggleLanIp: (enabled: boolean) => Promise<void>;
}

function NormalState({
  status,
  busy,
  confirming,
  onRequestEnable,
  onCancelEnable,
  onConfirmEnable,
  onDisable,
  onRescan,
  onToggleLanIp,
}: NormalStateProps) {
  return (
    <>
      <label
        data-testid="cowork-toggle"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: busy ? "wait" : "pointer",
          fontSize: 12,
          color: "var(--tandem-fg)",
          minHeight: 24,
        }}
      >
        <input
          data-testid="cowork-toggle-checkbox"
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) onRequestEnable();
            else void onDisable();
          }}
          style={{ accentColor: "var(--tandem-accent)" }}
        />
        <span>Enable Cowork integration</span>
      </label>
      <div style={helpTextStyle}>Token provisioned: {status.enabled ? "yes" : "no"}</div>

      {confirming === "enable" && (
        <div
          data-testid="cowork-enable-confirm"
          role="dialog"
          style={{
            border: "1px solid var(--tandem-warning-border)",
            background: "var(--tandem-warning-bg)",
            color: "var(--tandem-warning-fg-strong)",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Confirm: Enable Cowork</div>
          <div style={{ marginBottom: 8 }}>
            Windows will prompt for admin permission to modify firewall rules. This is expected.
            Tandem will write plugin entries to every detected Cowork workspace.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="cowork-enable-confirm-btn"
              type="button"
              onClick={() => void onConfirmEnable()}
              disabled={busy}
              style={primaryBtnStyle}
            >
              Enable
            </button>
            <button
              data-testid="cowork-enable-cancel-btn"
              type="button"
              onClick={onCancelEnable}
              disabled={busy}
              style={secondaryBtnStyle}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status.vethernetCidr !== null && (
        <div data-testid="cowork-vethernet-cidr" style={{ fontSize: 12 }}>
          Detected VM subnet: <code>{status.vethernetCidr}</code>
        </div>
      )}

      {status.lanIpFallback !== null && (
        <div>
          <label
            data-testid="cowork-lan-ip-override"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            <input
              data-testid="cowork-lan-ip-override-checkbox"
              type="checkbox"
              checked={status.useLanIpOverride}
              disabled={busy}
              onChange={(e) => void onToggleLanIp(e.target.checked)}
              style={{ accentColor: "var(--tandem-accent)" }}
            />
            <span>Use LAN IP instead of host.docker.internal</span>
          </label>
          <div style={helpTextStyle}>Fallback: {status.lanIpFallback}</div>
        </div>
      )}

      <div>
        <div style={sectionLabelStyle}>Workspaces ({status.workspaces.length})</div>
        {status.workspaces.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--tandem-fg-subtle)" }}>
            No Cowork workspaces detected yet.
          </div>
        ) : (
          <div
            data-testid="cowork-workspace-table"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            {status.workspaces.map((ws) => (
              <WorkspaceRow key={`${ws.workspaceId}/${ws.vmId}`} ws={ws} />
            ))}
          </div>
        )}
        <button
          data-testid="cowork-rescan-btn"
          type="button"
          onClick={onRescan}
          disabled={busy}
          style={{ ...secondaryBtnStyle, marginTop: 8 }}
        >
          Re-scan workspaces
        </button>
      </div>
    </>
  );
}

function WorkspaceRow({ ws }: { ws: WorkspaceStatus }) {
  const agg: WorkspaceFileStatus = aggregateWorkspaceStatus(ws);
  const tokens = STATUS_TOKENS[workspaceFileStatusFamily(agg)];
  const label = workspaceFileStatusLabel(agg);
  return (
    <div
      data-testid={`cowork-workspace-row-${ws.workspaceId}-${ws.vmId}`}
      data-status={agg}
      title={ws.failureDetail ?? ws.path}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        padding: "4px 6px",
        border: `1px solid ${tokens.border}`,
        background: tokens.bg,
        color: tokens.fg,
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ws.workspaceId} / {ws.vmId}
      </span>
      <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>
      {agg === "schemaDrift" && (
        <a
          data-testid={`cowork-workspace-report-${ws.workspaceId}-${ws.vmId}`}
          href="mailto:maintainers@tandem.invalid?subject=Cowork%20schema%20drift"
          style={{ color: "var(--tandem-error-fg-strong)", textDecoration: "underline" }}
        >
          Report
        </a>
      )}
    </div>
  );
}

const infoBannerStyle: React.CSSProperties = {
  border: "1px solid var(--tandem-info-border)",
  background: "var(--tandem-info-bg)",
  color: "var(--tandem-info-fg-strong)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
};

const errorBannerStyle: React.CSSProperties = {
  border: "1px solid var(--tandem-error-border)",
  background: "var(--tandem-error-bg)",
  color: "var(--tandem-error-fg-strong)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
};

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

export default CoworkSettings;
