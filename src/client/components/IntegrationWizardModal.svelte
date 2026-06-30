<script lang="ts">
/**
 * Unified onboarding wizard modal (detection-led, progressive disclosure).
 *
 * MAIN view: the MCP connect machine driven by `createIntegrationWizard()`
 * (detection → card selection → optional Advanced token → applying → done /
 * error), with a "More integrations" section below it surfacing Cowork
 * (opt-in, Windows-only) and an "AI models — coming soon" line.
 *
 * COWORK sub-view (`view === "cowork"`): a minimal enable screen lifted from
 * CoworkSettings — the firewall/UAC warning renders first and
 * `cowork-enable-confirm-btn` is the SOLE trigger of enable. The `{#if view}`
 * swap lives INSIDE the stable dialog shell (the node carrying
 * `bind:this={dialogEl}`); header/footer/scrim never churn, so the focus
 * trap is preserved across the toggle.
 *
 * App.svelte mounts via `{#if shouldShowWizard}` so closing unmounts the
 * component — that unmount (not `reset()`) is what restores freshness on
 * reopen, including firing the Cowork poller's `onDestroy`.
 *
 * Chrome follows the onboarding-modal family (FirstRun/ModelEdit): a single
 * padded card with flowing content — header, body, and actions stack with no
 * internal divider bars, and the whole card scrolls when a tall state
 * overflows. Shares the cluster-3.2 modal shell (color-mix scrim at
 * --tandem-z-above-titlebar, r-5 + shadow-3) and a Tab focus trap re-queried
 * per keypress (the Advanced <details> changes the focusable set while open).
 */
import { untrack } from "svelte";
import { BYO_MODELS_ENABLED, DEFAULT_MCP_PORT } from "../../shared/constants.js";
import type { ApplyItemResult, ExistingMcpInstall } from "../../shared/integrations/contract.js";
import {
  coworkSettingsVariant,
  formatCoworkError,
  isTauriRuntime,
  undetectedDetail,
} from "../cowork/cowork-helpers.js";
import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke.js";
import { createClaudeCliStatus } from "../hooks/useClaudeCliStatus.svelte.js";
import { createCoworkStatus } from "../hooks/useCoworkStatus.svelte.js";
import {
  createIntegrationWizard,
  detectedToPicked,
  type PickedIntegration,
} from "../hooks/useIntegrationWizard.svelte.js";
import {
  createReachabilityCheck,
  type ReachabilityStatus,
  type ReachabilityTarget,
} from "../hooks/useReachabilityCheck.svelte.js";
import IntegrationTargetCard from "./IntegrationTargetCard.svelte";

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

// Absolute base URL because the Vite dev server does not proxy /api/* —
// other client modules (yjsSync, useNotifications, fileUpload) follow the
// same pattern of pointing directly at the backend port.
const wizard = createIntegrationWizard({ baseUrl: `http://127.0.0.1:${DEFAULT_MCP_PORT}` });

// Single Cowork source of truth (feeds both the "More integrations" row and
// the Cowork sub-view). `getActive` is a PURE runtime check — it must never
// read coworkStatus.status/.loading, or the hook's own $effect (which writes
// them) would self-trigger `effect_update_depth_exceeded`. In the browser
// getActive() is false → the hook's effect early-returns, no interval ever
// starts; on Tauri the poller lives only while this component is mounted.
const coworkStatus = createCoworkStatus(() => isTauriRuntime());
// Render subscriptions (NOT effect reads) — safe.
const coworkVariant = $derived(coworkSettingsVariant(coworkStatus.status));

// Claude CLI binary probe for the empty state's one-click install. `getActive`
// reads only externals (`open`, `wizard.step`) — never cliStatus' own state —
// so the hook's fetch $effect can't self-trigger.
const cliStatus = createClaudeCliStatus(
  () => open && wizard.step === "connect",
  `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
);
// Gate the install CTA on a CONFIRMED NOT_INSTALLED. While presence is null
// (loading) we show the manual-MCP hint, so a user who already has the CLI
// never sees a flash of the install button before the GET resolves.
const showInstallCta = $derived(cliStatus.presence === "NOT_INSTALLED");
const showInstalledNotOnPath = $derived(cliStatus.presence === "INSTALLED_NOT_ON_PATH");

// Post-apply reachability (#1174 gap #1). Once the Done screen shows, verify the
// Tandem MCP server actually answers at the URL we just wrote (HTTP targets =
// Claude Code), and watch live for Claude connecting. stdio targets (Claude
// Desktop) have no running server to probe → rendered not-applicable. Only
// `applied` rows are verified; the join to `config.transport` mirrors
// `resultLabel`'s picked-lookup. `getActive` is PURE; the targets closure is
// snapshotted inside the hook (never read reactively in its effect).
const reachabilityTargets = $derived(
  wizard.applyResults
    .filter((r) => r.status === "applied")
    .map((r) => ({
      id: r.id,
      transport: wizard.picked.find((p) => p.id === r.id)?.config.transport,
    }))
    .filter((t): t is ReachabilityTarget => t.transport === "http" || t.transport === "stdio"),
);
const reachability = createReachabilityCheck(
  () => reachabilityTargets,
  () => open && wizard.step === "done",
  `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
);

function reachabilityStatusFor(id: string): ReachabilityStatus | null {
  return reachability.results.find((r) => r.id === id)?.status ?? null;
}

// Adapt the "what's next" guidance to the reachability outcome.
const whatsNext = $derived.by((): "connected" | "unreachable" | "stdio-only" | "default" => {
  const rows = reachability.results;
  const hasHttp = rows.some(
    (r) => r.status === "reachable" || r.status === "unreachable" || r.status === "verifying",
  );
  if (!hasHttp && rows.length > 0) return "stdio-only";
  if (rows.some((r) => r.status === "unreachable")) return "unreachable";
  if (reachability.claudeConnected) return "connected";
  return "default";
});

// MAIN ↔ COWORK sub-view toggle. Reset to "main" on (re)open below.
let view = $state<"main" | "cowork">("main");
// Per-mount Cowork enable state — component-local $state so unmount clears it
// and reopen is clean (explicitly NOT a module-level singleton).
let coworkBusy = $state(false);
let coworkError = $state<string | null>(null);

let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;
// User-entered token text per integration id (cleared after submit).
let secretInputs = $state<Record<string, string>>({});

$effect(() => {
  if (!open) return;
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  return () => {
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

$effect(() => {
  if (!open) return;
  // Reset to the MAIN view on (re)open. Unconditional (not `if (view ===
  // "cowork")`) so this effect never subscribes to `view` and can't re-fire
  // on a MAIN↔COWORK toggle. Defensive — a fresh mount already inits "main".
  view = "main";
  // Kick off detection on open. begin() is idempotent — calling on re-open
  // refreshes the existing-entries list.
  void wizard.begin();
});

/** Enable Cowork. `cowork-enable-confirm-btn` is the SOLE caller — never the
 *  footer, never sub-view mount. On success (or UAC-declined, which the Rust
 *  side leaves fail-closed with enabled:false) we refetch and return to MAIN
 *  so the Cowork row reflects the committed outcome; a thrown firewall error
 *  (incl. adminDeclined) shows inline and keeps the user on the sub-view. */
async function enableCowork(): Promise<void> {
  coworkBusy = true;
  coworkError = null;
  try {
    const invoke: InvokeFn = await loadInvoke();
    await coworkToggleIntegration(invoke, true);
    await coworkStatus.refetch();
    view = "main";
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    coworkError = formatCoworkError(raw);
  } finally {
    coworkBusy = false;
  }
}

/** Human-readable state line for the Cowork row in "More integrations". */
const coworkRowDetail = $derived.by(() => {
  if (coworkVariant === "loading") return "Checking…";
  if (coworkVariant === "unsupported") return "Coming soon to macOS & Linux";
  if (coworkVariant === "undetected") {
    // Three honest sub-states (see undetectedDetail): no Claude Desktop at
    // all, Claude present but Cowork never run, or sessions found in a
    // location the path guard rejects (network-redirected / synced AppData).
    const s = coworkStatus.status;
    const detail = s ? undetectedDetail(s) : "noClaude";
    if (detail === "blocked") {
      return "Found in a network-redirected or synced location Tandem can't safely configure";
    }
    if (detail === "noWorkspacesYet") {
      return "Claude Desktop detected — run a Cowork session once, then set up here";
    }
    return "Not detected on this computer";
  }
  const s = coworkStatus.status;
  if (s?.enabled) return "Connected — token provisioned";
  if (s?.uacDeclined) return "Setup didn't complete last time — try again from here";
  return "Let a teammate's Claude join from the Cowork VM";
});

$effect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
});

function close(): void {
  // Delete any keychain secret stored under Advanced but never persisted (the
  // user dismissed before saving). Gated inside the hook on the pre-persist
  // state, so it can never delete a live, file-referenced ref. Must run before
  // reset() clears `picked` — the hook captures the refs synchronously.
  void wizard.cleanupUnsavedSecrets().catch(() => {});
  wizard.reset();
  secretInputs = {};
  onClose();
}

/** Re-run detection from scratch — the open-$effect only fires on the
 *  open transition, so "Try again" / "Check again" must call begin()
 *  explicitly after reset(). Also re-probe binary presence: the cli-status
 *  $effect is keyed on `getActive()`, which doesn't change post-install, so
 *  it won't auto-re-probe. */
function retryDetection(): void {
  wizard.reset();
  secretInputs = {};
  void wizard.begin();
  void cliStatus.refetch();
  // The Cowork poller only refreshes every 30s — "Check again" must reflect a
  // Cowork session the user just started without the wait.
  void coworkStatus.refetch();
}

/** One-click install from the empty state. Branch on the RETURNED presence
 *  (not a post-await getter read — the install resolves in 30–120s, during
 *  which the modal may have closed; the hook's `mounted` guard is the
 *  load-bearing protection). If the CLI advanced past NOT_INSTALLED, re-run
 *  detection — `wizard.begin()` no-ops on a dead wizard. `existing` stays
 *  empty until the user first runs `claude` (which writes ~/.claude.json),
 *  so the INSTALLED_NOT_ON_PATH success banner carries the next step. */
async function onInstallClaude(): Promise<void> {
  const next = await cliStatus.install();
  if (next && next !== "NOT_INSTALLED") {
    void wizard.begin();
  }
}

/**
 * Tab focus trap (ported from SettingsModal). Re-queries focusables on
 * every Tab press because the Advanced <details> disclosure changes the
 * set while the dialog is open.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function trapTab(e: KeyboardEvent): void {
  if (e.key !== "Tab" || !dialogEl) return;
  const focusables = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null,
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialogEl)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// Match picked entries by `configPath` — the natural key the `{#each}` (keyed
// on configPath) and `save()` already use. Matching on `(kind, label)` was a
// fragile third identity key: two same-kind installs (classic + MSIX
// claude-desktop) could conflate selection state.
function togglePicked(install: ExistingMcpInstall): void {
  const existingIdx = wizard.picked.findIndex(
    (p) => p.config.configPath === install.target.configPath,
  );
  if (existingIdx >= 0) {
    wizard.setPicked(wizard.picked.filter((_, i) => i !== existingIdx));
    return;
  }
  const next = detectedToPicked(install);
  if (next) wizard.setPicked([...wizard.picked, next]);
}

function isPicked(install: ExistingMcpInstall): boolean {
  return wizard.picked.some((p) => p.config.configPath === install.target.configPath);
}

async function onSubmitSecret(picked: PickedIntegration): Promise<void> {
  const secret = secretInputs[picked.id] ?? "";
  if (secret.length === 0) return;
  await wizard.submitSecret(picked, secret);
  secretInputs[picked.id] = "";
}

const HTTP_5XX_RE = /HTTP 5\d\d/;
const HTTP_4XX_RE = /HTTP 4\d\d/;
const NETWORK_ERROR_RE = /fetch|network|Failed to/i;

const connectLabel = $derived(
  wizard.picked.length === 1 ? `Connect ${wizard.picked[0].config.label}` : "Connect selected",
);

/** Friendly name for an apply-result row — results carry integration ids,
 *  so resolve back through `picked` for the human label. */
function resultLabel(result: ApplyItemResult): string {
  return wizard.picked.find((p) => p.id === result.id)?.config.label ?? "Unknown";
}

/** Plain-language sentence for a failed apply result. Falls back to the
 *  server message, which is validated leak-safe (contract.ts). */
function resultErrorText(result: ApplyItemResult): string {
  switch (result.code) {
    case "WRITE_FAILED":
      return "Couldn't write the settings file — check it isn't open in another program, then try again.";
    case "SECRET_MISSING":
      return "The access token wasn't found — re-enter it under Advanced and try again.";
    case "TARGET_NOT_DETECTED":
      return "This assistant's settings file couldn't be found anymore — it may have moved.";
    case "PATH_REJECTED":
      return "The settings file is in an unexpected location, so Tandem left it alone for safety.";
    case "OTHER_MCP_NOT_APPLICABLE":
      return "Tandem can't auto-configure this app — connect it manually from that app's settings.";
    default:
      return result.message ?? "Something went wrong applying this one.";
  }
}

/** Plain-language lead for the error screen; raw detail stays in the
 *  collapsed Technical details block. */
const errorLead = $derived.by(() => {
  const msg = wizard.errorMessage ?? "";
  if (HTTP_5XX_RE.test(msg)) {
    return "Tandem's helper isn't responding. Make sure Tandem is running, then try again.";
  }
  if (HTTP_4XX_RE.test(msg)) {
    return "Tandem couldn't save the connection. Try again in a moment.";
  }
  if (NETWORK_ERROR_RE.test(msg)) {
    return "Couldn't reach Tandem — is it still running?";
  }
  return null;
});

const anyApplyErrors = $derived(wizard.applyResults.some((r) => r.status === "error"));
</script>

{#snippet warningIcon(cls?: string)}
  <svg
    class={cls}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3l9 16H3z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
{/snippet}

{#snippet checkIcon()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 13l4 4L19 7" />
  </svg>
{/snippet}

{#snippet chevronIcon()}
  <svg
    class="iw-chevron"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
{/snippet}

{#snippet loadingDots(label: string)}
  <div class="iw-loading" aria-live="polite">
    <span class="iw-dots" aria-hidden="true">
      <span class="iw-dot"></span><span class="iw-dot"></span><span class="iw-dot"></span>
    </span>
    {label}
  </div>
{/snippet}

{#snippet reachabilityLine(id: string)}
  {@const status = reachabilityStatusFor(id)}
  {#if status}
    <span
      class="iw-reachability iw-reachability-{status}"
      data-testid="integration-wizard-reachability-{id}"
      data-reachability-status={status}
    >
      {#if status === "verifying"}
        Checking Tandem is reachable…
      {:else if status === "reachable"}
        {reachability.claudeConnected ? "Claude connected just now" : "Tandem is responding"}
      {:else if status === "unreachable"}
        Config written, but the Tandem MCP server isn't responding — start Tandem, then restart
        Claude.
      {:else}
        Tandem starts when Claude Desktop opens
      {/if}
    </span>
  {/if}
{/snippet}

{#if open}
  <div
    role="presentation"
    class="iw-scrim"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    data-testid="integration-wizard"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Integration Setup Wizard"
      tabindex="-1"
      bind:this={dialogEl}
      class="iw-dialog"
      onkeydown={(e) => {
        // Handle Escape locally and stop it here so the window-level fallback
        // handler doesn't also fire close() (double-invoke). The early return
        // below skips the shared stopPropagation, so this branch must call it.
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
          return;
        }
        if (e.key === "Tab") {
          trapTab(e);
          return;
        }
        e.stopPropagation();
      }}
    >
      <header class="iw-header">
        <div class="iw-header-text">
          <h2 class="iw-title">
            {view === "cowork" ? "Set up Cowork" : "Connect Claude to Tandem"}
          </h2>
          {#if view === "main" && wizard.step === "connect"}
            <p class="iw-subtitle">Connect your AI assistant.</p>
          {:else if view === "cowork"}
            <p class="iw-subtitle">Let a teammate's Claude join from the Cowork VM.</p>
          {/if}
        </div>
        <button
          type="button"
          class="iw-close"
          onclick={close}
          aria-label="Close wizard"
          data-testid="integration-wizard-close"
        >
          ×
        </button>
      </header>

      <div class="iw-body">
        <!-- The {#if view} swap nests INSIDE the stable .iw-dialog shell (the
             node carrying bind:this={dialogEl}); only the body content swaps,
             so the focus trap never re-binds. -->
        {#if view === "cowork"}
          <section class="iw-step" data-testid="integration-wizard-cowork-step">
            {#if coworkStatus.status?.enabled}
              <div class="iw-whats-next">
                {@render checkIcon()}
                <span>
                  Cowork is enabled. Manage workspaces in Settings&nbsp;→&nbsp;Network.
                </span>
              </div>
            {:else}
              <div class="iw-banner-warning">
                {@render warningIcon()}
                <span>
                  Tandem registers itself as a plugin in every detected Cowork workspace so Claude
                  in Cowork can reach your open documents. This adds a Windows firewall rule so the
                  Cowork VM can connect back — admin is required once.
                </span>
              </div>
              {#if coworkStatus.status?.vethernetCidr}
                <p class="iw-hint-text" data-testid="cowork-vethernet-cidr">
                  Detected Cowork environment:
                  <code class="iw-code-inline">{coworkStatus.status.vethernetCidr}</code>
                </p>
              {/if}
              {#if coworkStatus.status?.uacDeclined}
                <p class="iw-hint-text">
                  A previous attempt couldn't update Windows Firewall (that needs administrator
                  rights). Enabling writes the workspace plugin entries either way.
                </p>
              {/if}
              <details class="iw-advanced" data-testid="integration-wizard-cowork-explainer">
                <summary>
                  {@render chevronIcon()}
                  What this does &amp; how to verify
                </summary>
                <div class="iw-advanced-body">
                  <p class="iw-hint-text">
                    You don't add a marketplace or run any commands inside Cowork — Tandem writes
                    the plugin entry for you. After enabling, open a Cowork session and ask Claude
                    to open or list your documents; Tandem's tools should appear. If they don't,
                    re-run “Enable Cowork”.
                  </p>
                  <p class="iw-hint-text">
                    Live updates (annotations and chat as they happen) need the Tandem desktop app
                    running; the Cowork connection itself is request-and-response.
                  </p>
                </div>
              </details>
            {/if}
            {#if coworkError}
              <div
                class="iw-banner-warning"
                role="alert"
                data-testid="integration-wizard-cowork-error"
              >
                {@render warningIcon()}
                <span>{coworkError}</span>
              </div>
            {/if}
          </section>
        {:else}
          {#if wizard.step === "connect"}
            <!-- Testid must stay on this wrapper (rendered for ALL connect
                 sub-states incl. loading/empty) — the E2E spec asserts it
                 visible immediately on open. -->
            <section class="iw-step" data-testid="integration-wizard-step-detect">
            {#if wizard.detecting}
              {@render loadingDots("Looking for Claude on your computer…")}
            {:else if wizard.existing.length === 0}
              <div class="iw-empty" data-testid="integration-wizard-empty">
                <p class="iw-empty-title">We couldn't find Claude on this computer.</p>
                {#if showInstallCta}
                  <p class="iw-hint-text">
                    Don't have Claude Code yet? Install it now — a small, signed download
                    straight from Anthropic.
                  </p>
                  <button
                    type="button"
                    class="iw-btn iw-btn-primary"
                    onclick={onInstallClaude}
                    disabled={cliStatus.installing}
                    data-testid="integration-wizard-install-claude"
                  >
                    {cliStatus.installing ? "Installing…" : "Install Claude Code"}
                  </button>
                  {#if cliStatus.installError}
                    <div
                      class="iw-banner-warning"
                      role="alert"
                      data-testid="integration-wizard-install-error"
                    >
                      {@render warningIcon()}
                      <span>{cliStatus.installError}</span>
                    </div>
                  {/if}
                {:else if showInstalledNotOnPath}
                  <div class="iw-whats-next" data-testid="integration-wizard-install-success">
                    {@render checkIcon()}
                    <span>
                      Claude Code is installed. Open a new terminal and run <code>claude</code>
                      once, then choose “Check again”.
                    </span>
                  </div>
                {/if}
                <p class="iw-hint-text">
                  If you use Claude Code or Claude Desktop, open it once, then check again. To
                  connect a different MCP-compatible app manually, point it at:
                </p>
                <code class="iw-code">http://127.0.0.1:{DEFAULT_MCP_PORT}/mcp</code>
              </div>
            {:else}
              <p class="iw-intro">
                We'll add a small entry to Claude's settings file so Claude can read and edit the
                documents you have open in Tandem. Nothing else is touched, and you can undo this
                any time.
              </p>
              <div class="iw-cards">
                {#each wizard.existing as install (install.target.configPath)}
                  <IntegrationTargetCard
                    {install}
                    selected={isPicked(install)}
                    onToggle={() => togglePicked(install)}
                  />
                {/each}
              </div>

              {#if wizard.picked.length > 0}
                <details class="iw-advanced" data-testid="integration-wizard-advanced">
                  <summary>
                    {@render chevronIcon()}
                    Advanced — set an access token
                  </summary>
                  <div class="iw-advanced-body">
                    <p class="iw-hint-text">
                      Only needed if you've changed Tandem to listen on your network instead of
                      just this computer. Most people can skip this. Tokens are stored in your
                      operating system's secure storage.
                    </p>
                    {#if wizard.keychainUnavailable}
                      <div class="iw-banner-warning" data-testid="integration-wizard-keychain-fallback">
                        {@render warningIcon()}
                        <span>
                          Your operating system's secure storage isn't reachable from this Tandem
                          build, so tokens entered here can't be saved. Set the environment
                          variable <code class="iw-code-inline">TANDEM_INTEGRATION_&lt;id&gt;_TOKEN</code>
                          instead, or add the token in your AI client's own configuration.
                        </span>
                      </div>
                    {/if}
                    {#each wizard.picked as picked (picked.id)}
                      <div class="iw-secret-row">
                        <span class="iw-secret-label">{picked.config.label}</span>
                        {#if picked.hasStoredSecret}
                          <span class="iw-secret-stored">
                            {@render checkIcon()}
                            Token saved
                          </span>
                        {:else if picked.keychainUnavailable}
                          <span class="iw-secret-skipped">Skipped (secure storage unavailable)</span>
                        {:else}
                          <div class="iw-secret-input">
                            <input
                              type="password"
                              placeholder="Paste access token"
                              bind:value={secretInputs[picked.id]}
                              data-testid="integration-wizard-secret-input-{picked.id}"
                            />
                            <button
                              type="button"
                              class="iw-btn iw-btn-secondary"
                              onclick={() => onSubmitSecret(picked)}
                              disabled={!secretInputs[picked.id]}
                              data-testid="integration-wizard-secret-submit-{picked.id}"
                            >
                              Save token
                            </button>
                          </div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </details>
              {/if}
            {/if}
            <!-- First-run dismissal is persisted per server version, so the
                 wizard never auto-reopens. Tell the user where the way back is
                 before they close it (#1022). -->
            <p
              class="iw-hint-text iw-reopen-hint"
              data-testid="integration-wizard-reopen-hint"
            >
              Not now? You can reopen this wizard anytime from Settings → AI Assistant.
            </p>
          </section>
        {:else if wizard.step === "applying"}
          <section class="iw-step iw-center" data-testid="integration-wizard-step-applying">
            {@render loadingDots("Connecting Claude…")}
            <p class="iw-hint-text">Updating Claude's settings file. This takes a second.</p>
          </section>
        {:else if wizard.step === "done"}
          <section class="iw-step" data-testid="integration-wizard-step-done">
            <div class="iw-done-header">
              <svg
                class="iw-done-check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path class="iw-check-path" d="M4 13l5 5L20 7" />
              </svg>
              <h3 class="iw-done-title">
                {anyApplyErrors ? "Partly connected" : "Claude is connected to Tandem"}
              </h3>
            </div>
            {#if reachability.phase === "verifying"}
              <div class="iw-verifying" data-testid="integration-wizard-step-verifying">
                {@render loadingDots("Verifying Claude can reach Tandem…")}
              </div>
            {/if}
            {#if wizard.applyResults.length > 0}
              <div class="iw-results">
                {#each wizard.applyResults as result (result.id)}
                  <div
                    class="iw-result iw-result-{result.status}"
                    data-testid="integration-wizard-apply-result-{result.id}"
                  >
                    <span class="iw-result-mark" aria-hidden="true">
                      {#if result.status === "applied"}
                        {@render checkIcon()}
                      {:else if result.status === "skipped"}
                        —
                      {:else}
                        {@render warningIcon()}
                      {/if}
                    </span>
                    <span class="iw-result-text">
                      <span class="iw-result-name">{resultLabel(result)}</span>
                      {#if result.status === "applied"}
                        <span class="iw-result-detail">Connected</span>
                        {@render reachabilityLine(result.id)}
                      {:else if result.status === "skipped"}
                        <span class="iw-result-detail">
                          Left unchanged (already set up, or couldn't be safely edited)
                        </span>
                      {:else}
                        <span class="iw-result-detail">{resultErrorText(result)}</span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="iw-whats-next" data-testid="integration-wizard-whats-next">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <path d="M12 8h.01" />
              </svg>
              <span>
                {#if whatsNext === "connected"}
                  Claude is connected and talking to Tandem. Ask it to open a document.
                {:else if whatsNext === "unreachable"}
                  Tandem doesn't seem to be running. Start Tandem, then restart Claude and run
                  <code class="iw-code-inline">/mcp</code>.
                {:else if whatsNext === "stdio-only"}
                  Open Claude Desktop to start using Tandem.
                {:else}
                  Restart Claude Code, then type <code class="iw-code-inline">/mcp</code> to verify —
                  or just ask Claude to open a document.
                {/if}
              </span>
            </div>
          </section>
        {:else if wizard.step === "error"}
          <section class="iw-step iw-center" data-testid="integration-wizard-step-error">
            {@render warningIcon("iw-error-icon")}
            <h3 class="iw-error-title">Something went wrong while connecting</h3>
            {#if errorLead}
              <p class="iw-hint-text">{errorLead}</p>
            {/if}
            {#if wizard.errorMessage}
              <details class="iw-tech-details">
                <summary>
                  {@render chevronIcon()}
                  Technical details
                </summary>
                <pre class="iw-tech-text">{wizard.errorMessage}</pre>
              </details>
            {/if}
          </section>
          {/if}

          {#if wizard.step === "connect" || wizard.step === "done"}
            <section class="iw-more" data-testid="integration-wizard-more">
              <div class="iw-more-label">More integrations</div>
              {#if isTauriRuntime()}
                <div class="iw-more-row">
                  <div class="iw-more-row-text">
                    <span class="iw-more-row-name">Cowork</span>
                    <span class="iw-more-row-detail">{coworkRowDetail}</span>
                  </div>
                  {#if coworkStatus.status?.enabled}
                    <span class="iw-more-badge">
                      {@render checkIcon()}
                      Enabled
                    </span>
                  {:else if coworkVariant === "normal"}
                    <button
                      type="button"
                      class="iw-btn iw-btn-secondary iw-more-btn"
                      onclick={() => { coworkError = null; coworkBusy = false; view = "cowork"; }}
                      aria-label="Set up Cowork"
                      data-testid="integration-wizard-cowork-setup"
                    >
                      Set up
                    </button>
                  {/if}
                </div>
              {/if}
              {#if !BYO_MODELS_ENABLED}
                <div class="iw-more-row iw-more-row-disabled">
                  <div class="iw-more-row-text">
                    <span class="iw-more-row-name">AI models</span>
                    <span class="iw-more-row-detail">Bring your own model — coming soon</span>
                  </div>
                </div>
              {/if}
            </section>
          {/if}
        {/if}
      </div>

      <footer class="iw-footer">
        {#if view === "cowork"}
          <button
            type="button"
            class="iw-btn iw-btn-secondary"
            onclick={() => (view = "main")}
            data-testid="integration-wizard-cowork-back"
            disabled={coworkBusy}
          >
            Back
          </button>
          {#if coworkStatus.status?.enabled}
            <button type="button" class="iw-btn iw-btn-primary" onclick={() => (view = "main")}>
              Done
            </button>
          {:else}
            <button
              type="button"
              class="iw-btn iw-btn-primary"
              onclick={enableCowork}
              disabled={coworkBusy}
              data-testid="cowork-enable-confirm-btn"
            >
              {coworkBusy ? "Enabling…" : "Enable Cowork"}
            </button>
          {/if}
        {:else if wizard.step === "connect"}
          {#if wizard.detecting}
            <button type="button" class="iw-btn iw-btn-secondary" onclick={close}>Cancel</button>
          {:else if wizard.existing.length === 0}
            <button type="button" class="iw-btn iw-btn-secondary" onclick={close}>Close</button>
            <button
              type="button"
              class="iw-btn iw-btn-primary"
              onclick={retryDetection}
              data-testid="integration-wizard-check-again"
            >
              Check again
            </button>
          {:else}
            <button type="button" class="iw-btn iw-btn-secondary" onclick={close}>
              Not now
            </button>
            <button
              type="button"
              class="iw-btn iw-btn-primary"
              onclick={() => wizard.save()}
              disabled={wizard.picked.length === 0}
              data-testid="integration-wizard-connect-btn"
            >
              {connectLabel}
            </button>
          {/if}
        {:else if wizard.step === "applying"}
          <button type="button" class="iw-btn iw-btn-secondary" disabled>Connecting…</button>
        {:else if wizard.step === "done"}
          {#if anyApplyErrors}
            <button
              type="button"
              class="iw-btn iw-btn-secondary"
              onclick={retryDetection}
              data-testid="integration-wizard-done-retry"
            >
              Try again
            </button>
          {/if}
          <button
            type="button"
            class="iw-btn iw-btn-primary"
            onclick={close}
            data-testid="integration-wizard-done-close"
          >
            Done
          </button>
        {:else if wizard.step === "error"}
          <button type="button" class="iw-btn iw-btn-secondary" onclick={close}>Close</button>
          <button
            type="button"
            class="iw-btn iw-btn-primary"
            onclick={retryDetection}
            data-testid="integration-wizard-error-retry"
          >
            Try again
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .iw-scrim {
    position: fixed;
    inset: 0;
    /* Theme-adaptive backdrop (cluster 3.2 modal recipe). */
    background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--tandem-space-5);
    z-index: var(--tandem-z-above-titlebar);
  }

  .iw-dialog {
    background-color: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border);
    /* Modal-family signature (cluster 3.2): r-5 corners + shadow-3, matching
       SettingsModal/ModelEdit (FirstRun/palette use shadow-4). Onboarding-card
       chrome — one padded card with flowing content (like FirstRun/ModelEdit),
       not SettingsModal's bordered fixed header/footer bars. */
    border-radius: var(--tandem-r-5);
    box-shadow: var(--tandem-shadow-3);
    width: 560px;
    max-width: calc(100vw - var(--tandem-space-6));
    max-height: min(640px, calc(100vh - var(--tandem-space-6)));
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-5);
    /* The whole card scrolls when a tall state overflows — header/footer flow
       with content rather than pinning, matching the onboarding-modal family. */
    overflow-y: auto;
    /* One above the scrim (sibling stacking) so the dialog sits over the
       titlebar like SettingsModal. */
    z-index: calc(var(--tandem-z-above-titlebar) + 1);
  }

  .iw-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--tandem-space-3);
    flex-shrink: 0;
  }

  .iw-header-text {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-1);
  }

  .iw-title {
    /* 18px·600 matches FirstRunModelPickerModal — the wizard's closest
       onboarding-modal sibling (text-lg is 17px; the family heading is 18). */
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }

  .iw-subtitle {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
    margin: 0;
  }

  /* Close button mirrors the cluster-3.2 modal family. */
  .iw-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--tandem-r-2);
    flex-shrink: 0;
  }
  .iw-close:hover,
  .iw-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .iw-body {
    display: flex;
    flex-direction: column;
  }

  .iw-step {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-4);
  }

  .iw-center {
    align-items: center;
    text-align: center;
    padding: var(--tandem-space-5) 0;
  }

  .iw-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--tandem-space-2);
    flex-shrink: 0;
  }

  .iw-btn {
    padding: var(--tandem-space-2) var(--tandem-space-4);
    font-size: var(--tandem-text-base);
    font-weight: 500;
    border-radius: var(--tandem-r-2);
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }
  .iw-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .iw-btn-primary {
    border: 1px solid transparent;
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
  }
  .iw-btn-primary:hover:not(:disabled) {
    background: var(--tandem-accent-hover);
  }
  .iw-btn-primary:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
  }
  .iw-btn-secondary {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
  }
  .iw-btn-secondary:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
  }
  .iw-btn-secondary:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
  }

  /* --- Connect: loading / empty / found --- */

  .iw-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-5) 0;
    font-size: var(--tandem-text-base);
    color: var(--tandem-fg-muted);
  }

  .iw-dots {
    display: inline-flex;
    gap: 4px;
  }
  .iw-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--tandem-r-circle);
    background: var(--tandem-fg-faint);
    animation: iw-dot-pulse 1.2s ease-in-out infinite;
  }
  .iw-dot:nth-child(2) {
    animation-delay: 0.15s;
  }
  .iw-dot:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes iw-dot-pulse {
    0%,
    80%,
    100% {
      opacity: 0.3;
      transform: scale(0.85);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .iw-intro {
    font-size: var(--tandem-text-base);
    line-height: 1.55;
    color: var(--tandem-fg);
    margin: 0;
  }

  .iw-cards {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
  }

  .iw-empty {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-4) 0;
  }
  .iw-empty-title {
    font-size: var(--tandem-text-md);
    font-weight: 600;
    margin: 0;
  }

  .iw-hint-text {
    font-size: var(--tandem-text-sm);
    line-height: 1.5;
    color: var(--tandem-fg-muted);
    margin: 0;
  }

  /* The parent .iw-step flex gap provides the spacing; only the tone differs
     from a regular hint (it's an aside, not step guidance). */
  .iw-reopen-hint {
    color: var(--tandem-fg-subtle);
  }

  .iw-code {
    align-self: flex-start;
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-sm);
    background: var(--tandem-surface-sunk);
    padding: var(--tandem-space-1) var(--tandem-space-2);
    border-radius: var(--tandem-r-2);
  }
  .iw-code-inline {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-xs);
    background: var(--tandem-surface-sunk);
    padding: 1px 4px;
    border-radius: var(--tandem-r-2);
  }

  /* --- Advanced disclosure --- */

  .iw-advanced summary,
  .iw-tech-details summary {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    cursor: pointer;
    list-style: none;
    padding: var(--tandem-space-2) 0;
    font-size: var(--tandem-text-sm);
    font-weight: 600;
    color: var(--tandem-fg);
    user-select: none;
  }
  .iw-advanced summary::-webkit-details-marker,
  .iw-tech-details summary::-webkit-details-marker {
    display: none;
  }
  /* Firefox/Safari paint the standard ::marker triangle over the custom
     chevron unless it's blanked too (matches CollapsibleSection). */
  .iw-advanced summary::marker,
  .iw-tech-details summary::marker {
    content: "";
  }

  .iw-chevron {
    width: 16px;
    height: 16px;
    color: var(--tandem-fg-subtle);
    transition: transform 140ms ease;
    flex-shrink: 0;
  }
  details[open] > summary .iw-chevron {
    transform: rotate(90deg);
  }

  .iw-advanced-body {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-2) 0 0;
  }

  .iw-banner-warning {
    display: flex;
    gap: var(--tandem-space-2);
    align-items: flex-start;
    padding: var(--tandem-space-3);
    background: var(--tandem-warning-bg);
    border: 1px solid var(--tandem-warning-border);
    border-radius: var(--tandem-r-3);
    color: var(--tandem-warning-fg-strong);
    font-size: var(--tandem-text-sm);
    line-height: 1.5;
  }
  .iw-banner-warning svg {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .iw-secret-row {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-1);
  }
  .iw-secret-label {
    /* Field-label recipe shared with .mem-label / .frm-label. */
    font-size: var(--tandem-text-xs);
    font-weight: 600;
    color: var(--tandem-fg);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .iw-secret-input {
    display: flex;
    gap: var(--tandem-space-2);
  }
  .iw-secret-input input {
    flex: 1;
    padding: var(--tandem-space-2);
    font-size: var(--tandem-text-base);
    font-family: var(--tandem-font-mono);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-2);
  }
  .iw-secret-input input:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: -1px;
  }
  .iw-secret-stored {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-1);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-success-fg-strong);
  }
  .iw-secret-stored svg {
    width: 14px;
    height: 14px;
  }
  .iw-secret-skipped {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-warning-fg-strong);
  }

  /* --- Done --- */

  .iw-done-header {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-3);
  }
  .iw-done-check {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    /* Tints the currentColor stroke; matches the .iw-result-applied mark and
       the success badge / secret-stored text. */
    color: var(--tandem-success-fg-strong);
  }
  .iw-check-path {
    stroke-dasharray: 24;
    stroke-dashoffset: 0;
    animation: iw-check-draw 260ms ease-out;
  }
  @keyframes iw-check-draw {
    from {
      stroke-dashoffset: 24;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  .iw-done-title {
    font-size: var(--tandem-text-lg);
    font-weight: 600;
    margin: 0;
  }

  .iw-results {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
  }
  .iw-result {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: var(--tandem-space-2);
    align-items: start;
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
  }
  .iw-result-mark {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
  }
  .iw-result-mark svg {
    width: 100%;
    height: 100%;
  }
  .iw-result-applied .iw-result-mark {
    color: var(--tandem-success-fg-strong);
  }
  .iw-result-skipped .iw-result-mark {
    color: var(--tandem-fg-faint);
  }
  .iw-result-error {
    background: var(--tandem-error-bg);
    border-color: var(--tandem-error-border);
  }
  .iw-result-error .iw-result-mark {
    color: var(--tandem-error-fg-strong);
  }
  .iw-result-error .iw-result-name {
    color: var(--tandem-error-fg-strong);
  }
  .iw-result-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .iw-result-name {
    font-size: var(--tandem-text-base);
    font-weight: 600;
  }
  .iw-result-detail {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }
  .iw-result-error .iw-result-detail {
    color: var(--tandem-error-fg-strong);
  }

  /* Post-apply reachability sub-line under an applied row. */
  .iw-reachability {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }
  .iw-reachability-reachable {
    color: var(--tandem-success-fg-strong);
  }
  .iw-reachability-unreachable {
    color: var(--tandem-warning-fg-strong);
  }

  /* Transient "Verifying…" banner above the result rows. */
  .iw-verifying {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }

  .iw-whats-next {
    display: flex;
    gap: var(--tandem-space-2);
    align-items: flex-start;
    padding: var(--tandem-space-3);
    background: var(--tandem-info-bg);
    border: 1px solid var(--tandem-info-border);
    border-radius: var(--tandem-r-3);
    font-size: var(--tandem-text-sm);
    line-height: 1.5;
    color: var(--tandem-info-fg-strong);
  }
  .iw-whats-next svg {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* --- More integrations --- */

  .iw-more {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
    margin-top: var(--tandem-space-4);
    padding-top: var(--tandem-space-4);
    border-top: 1px solid var(--tandem-border);
  }
  .iw-more-label {
    font-size: var(--tandem-text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tandem-fg);
  }
  .iw-more-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tandem-space-3);
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
  }
  .iw-more-row-disabled {
    opacity: 0.6;
  }
  .iw-more-row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .iw-more-row-name {
    font-size: var(--tandem-text-base);
    font-weight: 600;
  }
  .iw-more-row-detail {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }
  .iw-more-btn {
    flex-shrink: 0;
    padding: var(--tandem-space-1) var(--tandem-space-3);
  }
  .iw-more-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-1);
    flex-shrink: 0;
    font-size: var(--tandem-text-sm);
    font-weight: 600;
    color: var(--tandem-success-fg-strong);
  }
  .iw-more-badge svg {
    width: 14px;
    height: 14px;
  }

  /* --- Error --- */

  .iw-error-icon {
    width: 32px;
    height: 32px;
    color: var(--tandem-error-fg-strong);
  }
  .iw-error-title {
    font-size: var(--tandem-text-lg);
    font-weight: 600;
    margin: 0;
  }

  .iw-tech-details {
    align-self: stretch;
    text-align: left;
  }
  .iw-tech-text {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
    background: var(--tandem-surface-sunk);
    padding: var(--tandem-space-3);
    border-radius: var(--tandem-r-2);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* --- Reduced motion: both the OS preference and the in-app toggle. --- */
  @media (prefers-reduced-motion: reduce) {
    .iw-dot {
      /* The pulse keyframe starts at 0.3 opacity; freezing there leaves the
         dots nearly invisible, so pin a visible resting opacity. */
      animation: none;
      opacity: 0.7;
    }
    .iw-check-path {
      animation: none;
    }
    .iw-btn,
    .iw-chevron {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .iw-dot {
    animation: none;
    opacity: 0.7;
  }
  :global(body.tandem-reduce-motion) .iw-check-path {
    animation: none;
  }
  :global(body.tandem-reduce-motion) .iw-btn,
  :global(body.tandem-reduce-motion) .iw-chevron {
    transition: none;
  }
</style>
