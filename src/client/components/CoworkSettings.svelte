<script lang="ts">
import { onDestroy } from "svelte";
import {
  COWORK_RESCAN_DEBOUNCE_MS,
  TANDEM_REPO_URL,
  TANDEM_SUPPORT_EMAIL,
} from "../../shared/constants";
import {
  aggregateWorkspaceStatus,
  COWORK_PREFLIGHT_CHECKING,
  coworkReachability,
  coworkReachabilityCopy,
  coworkSettingsVariant,
  formatCoworkError,
  makeDebouncer,
  type StatusTokenFamily,
  undetectedDetail,
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
import { createSubnetPreflight } from "../hooks/useCoworkPreflight.svelte";
import { createCoworkStatus } from "../hooks/useCoworkStatus.svelte";
import type { WorkspaceFileStatus, WorkspaceStatus } from "../types";
import { resyncCheckbox } from "../utils/checkbox-sync";

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
  neutral: {
    bg: "var(--tandem-info-bg)",
    fg: "var(--tandem-info-fg-strong)",
    border: "var(--tandem-info-border)",
  },
};

// Always active while mounted
const coworkState = createCoworkStatus(() => true);
const { refetch } = coworkState;

let inlineToastMessage = $state<string | null>(null);
let confirming = $state<"enable" | null>(null);
let busy = $state(false);
// #1298: probe the Hyper-V subnet before offering Enable, so a detection
// failure says what is wrong instead of blaming the Cowork install. See
// CoworkOnboardingStep for why this runs on confirm rather than on mount.
const probe = createSubnetPreflight();

function openEnableConfirm(): void {
  confirming = "enable";
  void probe.run();
}

/** Abandon any in-flight probe so its result can't land on a closed banner. */
function closeEnableConfirm(): void {
  confirming = null;
  probe.reset();
}

const debouncer = makeDebouncer(COWORK_RESCAN_DEBOUNCE_MS);
onDestroy(() => debouncer.cancel());

const variant = $derived(coworkSettingsVariant(coworkState.status));
const reachability = $derived(coworkReachability(coworkState.status));

function reachabilityBannerStyle(family: StatusTokenFamily): string {
  const tokens = STATUS_TOKENS[family];
  return `border: 1px solid ${tokens.border}; background: ${tokens.bg}; color: ${tokens.fg}; border-radius: var(--tandem-r-3); padding: 8px 10px; font-size: 12px;`;
}

async function withInvoke(
  op: (invoke: InvokeFn) => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  busy = true;
  try {
    const invoke = await loadInvoke();
    await op(invoke);
    inlineToastMessage = null;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const display = formatCoworkError(rawMsg);
    inlineToastMessage = `${errorPrefix}: ${display}`;
  } finally {
    busy = false;
  }
}

async function handleToggleOn(): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, true);
    await refetch();
    closeEnableConfirm();
  }, "Failed to enable Cowork");
}

/**
 * The Enable checkbox's rendered state, in ONE place.
 *
 * `resyncCheckbox` writes `box.checked` directly and does not update the cache
 * Svelte's `set_checked` keeps, so a resync to a value the `checked=` expression
 * disagrees with LATCHES: the next re-computation back to the cached value is
 * skipped and the box can no longer be moved. Passing the same expression to
 * both makes that structurally impossible instead of incidentally true.
 */
const enableBoxChecked = $derived(
  (coworkState.status?.enabled ?? false) || confirming === "enable",
);

async function handleToggleOff(box: HTMLInputElement): Promise<void> {
  // Gate the resync on the READ-BACK, not on the write. `refetch()` swallows
  // its own failure into `coworkState.error`, so after a successful toggle
  // whose refetch failed, `status` still says `enabled: true` — and resyncing
  // from it would visibly re-check the box over an integration that is now off.
  // Three cases, and only the middle one is safe to paint from:
  //   toggle threw            -> status unchanged AND accurate  -> resync
  //   toggle ok, refetch ok   -> status fresh                   -> resync
  //   toggle ok, refetch fail -> status stale and WRONG         -> leave the
  //     box where the user put it, which is what the write we know landed did.
  // Not the same thing as #1437, which is an HONEST refetch reporting a partial
  // commit — there `status` is fresh and must be believed.
  let readBack = true;
  await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, false);
    readBack = await refetch();
  }, "Failed to disable Cowork");
  if (readBack) resyncCheckbox(box, enableBoxChecked);
}

/**
 * The Enable checkbox's only handler — and three of its four cases are not an
 * enable.
 *
 * Checking a box that already shows off while the integration is ON is the user
 * correcting the display, not asking for an enable — so that branch suppresses
 * the confirm and lets the click stand rather than firing a UAC prompt and a
 * firewall write for the state the user is already in. (It needs no
 * `resyncCheckbox`: the browser's own toggle is what heals it, and an
 * assignment there would write `true` over `true`.)
 *
 * Unchecking while the confirm is open is a cancel, not a disable — it used to
 * fall through to `handleToggleOff` and fire a real
 * `coworkToggleIntegration(invoke, false)` for a transition that had never
 * happened, leaving the confirm standing behind it. The two unchecked-branch
 * conditions are independent rather than either/or: the 30s status poll can
 * report an enable from another surface while this confirm sits open, so
 * cancelling a pending enable and disabling a live one are separate
 * obligations that can both be due.
 */
function handleToggleChange(box: HTMLInputElement): void {
  const enabled = coworkState.status?.enabled ?? false;
  if (box.checked) {
    if (!enabled) openEnableConfirm();
    return;
  }
  if (confirming === "enable") closeEnableConfirm();
  if (enabled) void handleToggleOff(box);
}

function handleRescan(): void {
  debouncer.schedule(() => {
    void withInvoke(async (invoke) => {
      await coworkRescan(invoke);
      await refetch();
    }, "Re-scan failed");
  });
}

async function handleToggleLanIp(box: HTMLInputElement): Promise<void> {
  const enabled = box.checked;
  let readBack = true;
  await withInvoke(async (invoke) => {
    await coworkSetLanIpOverride(invoke, enabled);
    readBack = await refetch();
  }, "Failed to update LAN-IP override");
  // Same hazard as the Enable toggle, same read-back gate — and with no confirm
  // banner to mask it, the snap-back is this row's entire signal.
  if (readBack) resyncCheckbox(box, coworkState.status?.useLanIpOverride ?? false);
}

function workspaceRowStyle(ws: WorkspaceStatus): string {
  const agg: WorkspaceFileStatus = aggregateWorkspaceStatus(ws);
  const tokens = STATUS_TOKENS[workspaceFileStatusFamily(agg)];
  return `display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 6px; border: 1px solid ${tokens.border}; background: ${tokens.bg}; color: ${tokens.fg}; border-radius: var(--tandem-r-2); font-size: 11px;`;
}
</script>

<div class="cs-root" data-testid="cowork-settings">
  <div class="cs-label">Cowork Integration</div>

  {#if coworkState.loading}
    <div class="cs-help-text" data-testid="cowork-settings-loading">
      Loading Cowork status...
    </div>
  {:else if variant === "unsupported"}
    <div class="cs-info-banner" data-testid="cowork-settings-unsupported">
      Cowork integration is available on Windows today. macOS/Linux support is tracked in #316 /
      #317.
    </div>
  {:else if variant === "undetected"}
    {@const detail = coworkState.status ? undetectedDetail(coworkState.status) : "noClaude"}
    <div class="cs-info-banner" data-testid="cowork-settings-undetected" data-detail={detail}>
      {#if detail === "blocked"}
        Cowork sessions were found in a network-redirected or cloud-synced location that Tandem
        can't safely configure.{" "}
      {:else if detail === "noWorkspacesYet"}
        Claude Desktop detected. Run a Cowork session once, then enable the integration here —
        Tandem keeps newly created workspaces configured automatically.{" "}
      {:else}
        Cowork not detected on this system.{" "}
      {/if}
      <a class="cs-link" href={`${TANDEM_REPO_URL}#cowork`} target="_blank" rel="noreferrer">
        Learn more
      </a>
    </div>
  {:else if variant === "normal" && coworkState.status !== null}
    {@const s = coworkState.status}
    <!-- Toggle -->
    <label
      class="cs-toggle"
      class:is-busy={busy}
      data-testid="cowork-toggle"
    >
      <!-- `enableBoxChecked`, not a second copy of the expression: the resync
           in `handleToggleOff` must pass the SAME value this renders, or the two
           writers latch against each other. The `|| confirming` term is what
           makes Cancel un-check the box again — `s.enabled` never changed on the
           way in, so binding to it alone left a checked box sitting over a
           disabled integration until the next status refetch. What this
           expression cannot do is repair the disable half, and not because it
           computes the wrong value: it computes the right one and `set_checked`
           skips the write because its cache already holds it. See
           `utils/checkbox-sync.ts`. -->
      <input
        class="cs-accent-cbx"
        data-testid="cowork-toggle-checkbox"
        type="checkbox"
        checked={enableBoxChecked}
        disabled={busy}
        onchange={(e) => handleToggleChange(e.currentTarget)}
      />
      <span>Enable Cowork integration</span>
    </label>
    <div class="cs-help">Integration enabled: {s.enabled ? "yes" : "no"}</div>

    {#if reachability !== "not-applicable"}
      {@const copy = coworkReachabilityCopy(reachability)}
      <div
        class="cs-reachability"
        data-testid="cowork-reachability"
        data-reachability={reachability}
        role={reachability === "unreachable" ? "alert" : undefined}
        style={reachabilityBannerStyle(copy.family)}
      >
        <div class="cs-reachability-title">{copy.title}</div>
        <div class="cs-reachability-detail">{copy.detail}</div>
      </div>
    {/if}

    <details class="cs-explainer" data-testid="cowork-explainer">
      <summary>What this does &amp; how to verify</summary>
      <div class="cs-explainer-body">
        <p>
          Enabling registers Tandem as a plugin in every detected Cowork workspace, so Claude
          running inside Cowork can reach the documents you have open. This needs Windows admin
          once to add a firewall rule that lets the Cowork VM connect back to Tandem on this
          computer — you don't add a marketplace or run any commands inside Cowork yourself.
        </p>
        <p>
          <strong>Verify:</strong> in a Cowork session, ask Claude to open or list your documents
          — Tandem's tools should appear. If they don't, re-run “Enable” here.
        </p>
        <p>
          <strong>Note:</strong> live updates (annotations and chat as they happen) need the
          Tandem desktop app running; the Cowork connection itself is request-and-response.
        </p>
      </div>
    </details>

    {#if confirming === "enable"}
      <div
        class="cs-warning-banner"
        data-testid="cowork-enable-confirm"
        role="dialog"
      >
        <div class="cs-confirm-heading">Confirm: Enable Cowork</div>
        <div class="cs-confirm-body">
          Tandem will register itself as a plugin in every detected Cowork workspace so Claude in
          Cowork can reach your open documents. This adds a Windows firewall rule so the Cowork VM
          can connect back — admin is required once.
        </div>
        <!-- #1376: mounted-before-populated, and the two children are additive.
             `useCoworkPreflight.svelte.ts` explains both and is the one place
             that should. -->
        <div role="status" data-testid="cowork-preflight-live">
          {#if probe.preflight?.status === "blocked"}
            <!-- #1298: we already watched detection fail, so offer a retry rather
                 than an Enable button whose outcome we know. -->
            <div class="cs-preflight" data-testid="cowork-preflight-blocked">
              {probe.preflight.hint}
            </div>
          {/if}
          {#if probe.probing}
            <div class="cs-help-text">{COWORK_PREFLIGHT_CHECKING}</div>
          {/if}
        </div>
        <div class="cs-actions">
          {#if probe.preflight?.status === "blocked"}
            <button
              class="cs-btn cs-btn--primary"
              data-testid="cowork-preflight-retry-btn"
              type="button"
              onclick={() => void probe.run()}
              disabled={busy || probe.probing}
            >
              {probe.probing ? "Checking…" : "Check again"}
            </button>
          {:else}
            <button
              class="cs-btn cs-btn--primary"
              data-testid="cowork-enable-confirm-btn"
              type="button"
              onclick={() => void handleToggleOn()}
              disabled={busy}
            >
              Enable
            </button>
          {/if}
          <button
            class="cs-btn cs-btn--ghost"
            data-testid="cowork-enable-cancel-btn"
            type="button"
            onclick={closeEnableConfirm}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if s.vethernetCidr !== null}
      <div class="cs-vethernet" data-testid="cowork-vethernet-cidr">
        Detected Cowork environment: <code>{s.vethernetCidr}</code>
      </div>
    {/if}

    {#if s.lanIpFallback !== null}
      <div>
        <label
          class="cs-toggle"
          class:is-busy={busy}
          data-testid="cowork-lan-ip-override"
        >
          <input
            class="cs-accent-cbx"
            data-testid="cowork-lan-ip-override-checkbox"
            type="checkbox"
            checked={s.useLanIpOverride}
            disabled={busy}
            onchange={(e) => void handleToggleLanIp(e.currentTarget)}
          />
          <span>Use LAN IP instead of host.docker.internal</span>
        </label>
        <div class="cs-help">Fallback: {s.lanIpFallback}</div>
      </div>
    {/if}

    <div>
      <div class="cs-label">Workspaces ({s.workspaces.length})</div>
      {#if s.workspaces.length === 0}
        <div class="cs-help-text">No Cowork workspaces detected yet.</div>
      {:else}
        <div class="cs-workspace-table" data-testid="cowork-workspace-table">
          {#each s.workspaces as ws (`${ws.workspaceId}/${ws.vmId}`)}
            {@const agg = aggregateWorkspaceStatus(ws)}
            {@const label = workspaceFileStatusLabel(agg)}
            <div
              class="cs-workspace-row"
              data-testid={`cowork-workspace-row-${ws.workspaceId}-${ws.vmId}`}
              data-status={agg}
              title={ws.failureDetail ?? ws.path}
              style={workspaceRowStyle(ws)}
            >
              <span class="cs-workspace-id">{ws.workspaceId} / {ws.vmId}</span>
              <span class="cs-workspace-label">{label}</span>
              {#if agg === "schemaDrift"}
                <a
                  class="cs-report-link"
                  data-testid={`cowork-workspace-report-${ws.workspaceId}-${ws.vmId}`}
                  href={`mailto:${TANDEM_SUPPORT_EMAIL}?subject=Cowork%20schema%20drift`}
                >
                  Report
                </a>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      <button
        class="cs-btn cs-btn--ghost cs-rescan-btn"
        data-testid="cowork-rescan-btn"
        type="button"
        onclick={handleRescan}
        disabled={busy}
      >
        Re-scan workspaces
      </button>
    </div>
  {/if}

  <!-- Not gated on `!coworkState.status`. That gate made this dead for every
       failure after the first load — which is every failure a user of the
       toggle can cause, since the toggle only exists once a status has loaded.
       `refetch()` reports its failure by setting `error` and returning false
       rather than throwing, so without this a re-read that fails leaves the
       whole surface showing stale values with nothing to say so. -->
  {#if coworkState.error}
    <div class="cs-error-banner" data-testid="cowork-settings-error" role="alert">
      {coworkState.status ? "Couldn't refresh Cowork status" : "Failed to load Cowork status"}: {coworkState.error}
    </div>
  {/if}

  {#if inlineToastMessage}
    <div class="cs-error-banner" data-testid="cowork-inline-toast" role="alert">
      {inlineToastMessage}
    </div>
  {/if}
</div>

<style>
  .cs-root {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cs-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--tandem-fg);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .cs-help-text {
    font-size: 12px;
    color: var(--tandem-fg-subtle);
  }
  .cs-help {
    font-size: 10px;
    color: var(--tandem-fg-subtle);
    margin-top: 4px;
  }
  .cs-info-banner {
    border: 1px solid var(--tandem-info-border);
    background: var(--tandem-info-bg);
    color: var(--tandem-info-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-error-banner {
    border: 1px solid var(--tandem-error-border);
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-warning-banner {
    border: 1px solid var(--tandem-warning-border);
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-confirm-heading {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .cs-confirm-body {
    margin-bottom: 8px;
  }
  /* The detection failure has to read as a distinct thing, not as a third
     paragraph of the confirm blurb. It already inherits the warning tokens from
     `.cs-warning-banner`, so a border is what separates it — matching
     `.cos-preflight` in CoworkOnboardingStep, which renders the same hint. */
  .cs-preflight {
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid var(--tandem-warning-border);
    border-radius: var(--tandem-r-2);
    padding: 6px 8px;
    margin-bottom: 8px;
  }
  .cs-link {
    color: var(--tandem-accent);
  }

  .cs-explainer {
    font-size: 12px;
    color: var(--tandem-fg-muted);
  }
  .cs-explainer > summary {
    cursor: pointer;
    color: var(--tandem-accent);
    font-size: 11px;
  }
  .cs-explainer-body {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    line-height: 1.5;
  }
  .cs-explainer-body p {
    margin: 0;
  }

  .cs-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    color: var(--tandem-fg);
    min-height: 24px;
  }
  .cs-toggle.is-busy {
    cursor: wait;
  }
  .cs-accent-cbx {
    accent-color: var(--tandem-accent);
  }

  .cs-vethernet {
    font-size: 12px;
  }

  /* Reachability banner. border/bg/fg are computed at runtime by
     reachabilityBannerStyle() since they vary per status family, keeping the
     status-family map the single source of truth (same pattern as the
     workspace rows). */
  .cs-reachability-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .cs-reachability-detail {
    line-height: 1.4;
  }

  .cs-actions {
    display: flex;
    gap: 8px;
  }
  .cs-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--tandem-r-2);
    cursor: pointer;
  }
  .cs-btn--primary {
    border: 1px solid var(--tandem-accent);
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    font-weight: 600;
  }
  .cs-btn--primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cs-btn--ghost {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface);
    color: var(--tandem-fg-muted);
  }
  .cs-btn--ghost:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .cs-btn--ghost:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cs-rescan-btn {
    margin-top: 8px;
  }

  /* Workspace rows. The per-row border/bg/fg are computed at runtime by
     workspaceRowStyle() because they vary per status family (success /
     warning / error) — leaving that inline keeps the status-family map as
     the source of truth. */
  .cs-workspace-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cs-workspace-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--tandem-r-2);
    font-size: 11px;
  }
  .cs-workspace-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs-workspace-label {
    font-weight: 600;
    white-space: nowrap;
  }
  .cs-report-link {
    color: var(--tandem-error-fg-strong);
    text-decoration: underline;
  }
</style>
