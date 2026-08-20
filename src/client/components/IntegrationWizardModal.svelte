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
import { tick, untrack } from "svelte";
import { BYO_MODELS_ENABLED, CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../shared/constants.js";
import type { ApplyItemResult, ExistingMcpInstall } from "../../shared/integrations/contract.js";
import {
  COWORK_PREFLIGHT_CHECKING,
  COWORK_PREFLIGHT_FAILED,
  coworkSettingsVariant,
  formatCoworkError,
  isTauriRuntime,
  undetectedDetail,
} from "../cowork/cowork-helpers.js";
import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke.js";
import {
  autostartWizardDefault,
  createAutostart,
  readAutostartDecided,
  writeAutostartDecided,
} from "../hooks/useAutostart.svelte.js";
import { createClaudeCliStatus } from "../hooks/useClaudeCliStatus.svelte.js";
import { createSubnetPreflight } from "../hooks/useCoworkPreflight.svelte.js";
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
import { MCP_BASE_URL } from "../utils/backend-ports.js";
import { resyncCheckbox } from "../utils/checkbox-sync.js";
import { logClientWarning } from "../utils/client-log.js";
import IntegrationTargetCard from "./IntegrationTargetCard.svelte";
import {
  computeDoneHeaderState,
  type PushSupportNote,
  pushSupportNote,
} from "./integration-wizard-helpers.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Close the wizard and open the Models settings path. Wired by App.svelte to
   * `openModelsSettings`. Only invoked from the flag-ON "AI models" row, which
   * never renders while `BYO_MODELS_ENABLED` is false — so this stays unused
   * (and undefined-safe via `?.`) while dark.
   */
  onSetupModels?: () => void;
}

let { open, onClose, onSetupModels }: Props = $props();

// Absolute base URL because the Vite dev server does not proxy /api/* —
// other client modules (yjsSync, useNotifications, fileUpload) follow the
// same pattern of pointing directly at the backend port.
const wizard = createIntegrationWizard({ baseUrl: MCP_BASE_URL });

// Single Cowork source of truth (feeds both the "More integrations" row and
// the Cowork sub-view). `getActive` is a PURE runtime check — it must never
// read coworkStatus.status/.loading, or the hook's own $effect (which writes
// them) would self-trigger `effect_update_depth_exceeded`. In the browser
// getActive() is false → the hook's effect early-returns, no interval ever
// starts; on Tauri the poller lives only while this component is mounted.
const coworkStatus = createCoworkStatus(() => isTauriRuntime());

/* Start at login (#1463 step 3). A MITIGATION, not a fix: it reduces how often
   a user reaches Claude Code with Tandem down, and closes nothing — it is
   desktop-only, and covers neither a crash, a deliberate quit, nor anyone who
   already finished the wizard. The real fix is the skill's absent-tools rule.

   Same hook as Settings → Network, so the OS stays the single source of truth
   and no `tandem:settings` field appears (see `useAutostart.svelte.ts` — do not
   add one). Gated on the `done` step rather than `open`, so a user who never
   finishes setup is never registered. */
const wizardAutostart = createAutostart(() => open && isTauriRuntime() && wizard.step === "done");
const wizardAutostartStatus = $derived(wizardAutostart.status);
const wizardAutostartBlocked = $derived(
  wizardAutostartStatus !== null && !wizardAutostartStatus.trayAvailable,
);

/* "Checked by default" is implemented as an actual enable on first render, not
   a pre-ticked box that does nothing until the wizard closes. A box reading
   checked while the OS registration is absent is a lie, and the honest
   alternative is worse: applying inside `close()` would swallow the failure at
   exactly the moment the surface that would report it is unmounting.

   **It defaults on only for someone who has never chosen.** `readAutostartDecided()`
   is the whole reason that sentence can be written: the OS reports `enabled:
   false` identically for "never set up" and "deliberately turned off", so
   without it the wizard cannot tell a default from an override, and re-running
   setup would silently switch start-at-login back on for someone who had
   turned it off. Any toggle on either surface records the decision, so this
   fires at most once in an install's life.

   Three further guards, each load-bearing: the latch keeps a re-render from
   re-firing it, `trayAvailable` keeps it from registering a hidden startup with
   no way to reach the app, and `st.enabled` keeps it from writing a value the
   OS already holds. */
let autostartDefaultApplied = $state(false);
$effect(() => {
  if (!open || wizard.step !== "done") return;
  const decision = autostartWizardDefault(wizardAutostartStatus, readAutostartDecided());
  if (!decision.enable && !decision.record) return;
  if (untrack(() => autostartDefaultApplied)) return;
  autostartDefaultApplied = true;
  // `toggle()` records the decision itself, so `record` is only ever set on the
  // arm that does not enable.
  if (decision.record) writeAutostartDecided();
  if (decision.enable) void wizardAutostart.toggle(true);
});

/**
 * `resyncCheckbox` because `checked={wizardAutostartStatus.enabled}` cannot
 * repair itself, exactly as in `NetworkSettings.svelte` — see that helper for
 * the mechanism. It is not optional here just because this is a setup screen:
 * `autostart_set_enabled` returns `io-error` / `readback-mismatch` WITHOUT
 * rejecting, so `toggle()`'s catch never fires, `status.enabled` is unchanged,
 * the expression re-computes to the value Svelte last wrote, the DOM write is
 * skipped, and the box latches where the user clicked over a setting that never
 * moved. Resyncing from the status THIS call returned, so there is no stale-read
 * hazard.
 */
async function toggleWizardAutostart(box: HTMLInputElement): Promise<void> {
  await wizardAutostart.toggle(box.checked);
  resyncCheckbox(box, wizardAutostart.status?.enabled ?? false);
}
// Render subscriptions (NOT effect reads) — safe.
const coworkVariant = $derived(coworkSettingsVariant(coworkStatus.status));

// Claude CLI binary probe for the empty state's one-click install. `getActive`
// reads only externals (`open`, `wizard.step`) — never cliStatus' own state —
// so the hook's fetch $effect can't self-trigger.
const cliStatus = createClaudeCliStatus(() => open && wizard.step === "connect", MCP_BASE_URL);
// Gate the install CTA on a CONFIRMED NOT_INSTALLED. While presence is null
// (loading) we show the manual-MCP hint, so a user who already has the CLI
// never sees a flash of the install button before the GET resolves.
const showInstallCta = $derived(cliStatus.presence === "NOT_INSTALLED");
const showInstalledNotOnPath = $derived(cliStatus.presence === "INSTALLED_NOT_ON_PATH");
// Rendered OUTSIDE the "we couldn't find Claude" empty state, unlike the two
// flags above. The affected user — a Windows npm-global install — has almost
// always run `claude` from a terminal once (cmd/PowerShell honor PATHEXT, so
// the shim works there), which writes the config `detectTargets` keys on. They
// land in the NON-empty branch, where the empty state's CLI messaging never
// renders, so gating this on it would reach nearly nobody.
const showShimWarning = $derived(cliStatus.bareNameLaunchable === false);

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
  MCP_BASE_URL,
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
const coworkProbe = createSubnetPreflight();

// #1390: the plugin install commands, plus the outcome of the button that
// copies them. The outcome lives beside the button in its own live region
// rather than in the button's label — a changed accessible name on a button
// nobody is focused on is announced by nothing, which is the same mistake
// #1376 exists to fix.
const PLUGIN_INSTALL_TEXT = CLAUDE_PLUGIN_INSTALL_COMMANDS.join("\n");

/**
 * Outcome of the Copy button, announced from its own live region.
 *
 * MUST be `""` whenever the push-routes block is about to (re)mount — a live
 * region created already holding its text is announced by nothing, which is
 * #1376's defect reintroduced inside the fix for it. Unlike `coworkProbe`,
 * there is no single choke point to hang that on, so the reset is explicit at
 * each transition that can remount the block — `openCoworkView` and
 * `retryDetection` — and `copyToken` is what makes that safe.
 *
 * `close()` deliberately does not reset, and that is the one leg of this
 * invariant the component does not own: it holds only because `App.svelte`
 * renders the modal under `{#if shouldShowWizard}`, so closing DESTROYS this
 * state rather than hiding it. The component is otherwise written for a
 * persistent `open` prop, and under that shape a close/reopen would remount the
 * block still holding "Copied". If the parent ever stops unmounting, this needs
 * a third reset site.
 */
let pluginCopyResult = $state("");

/**
 * Monotonic ticket, same device as `createSubnetPreflight`'s. The clear is
 * synchronous and the write is two awaits later, so without it a clear cannot
 * dominate an in-flight copy: click Copy, click the Cowork row before the
 * clipboard settles, and the continuation writes "Copied" into an unmounted
 * region that then remounts holding it — the exact thing the clear exists to
 * prevent, caused by the clear's own async gap.
 */
let copyToken = 0;

async function copyPluginCommands(): Promise<void> {
  const mine = ++copyToken;
  let result: string;
  // `writeText` FIRST, with no await before it. WebKit invalidates the
  // user-gesture token across an `await`, so a clipboard write placed after one
  // can be rejected for want of transient activation — hence the clear-and-flush
  // below happens after the write, not before. (Not testable here: happy-dom
  // models no activation state, so this is pinned by the comment, deliberately.)
  try {
    await navigator.clipboard.writeText(PLUGIN_INSTALL_TEXT);
    result = "Copied";
  } catch (err) {
    // Not rethrown: the message says everything actionable and the commands
    // stay on screen to be selected by hand. Logged anyway — a denied
    // permission, a WebView with no `navigator.clipboard`, and a security
    // policy rejection are three different bugs with three different fixes,
    // and after this catch nobody can tell which one a user hit.
    // Via `logClientWarning` rather than `console.warn` so the distinguishing
    // error name survives into a bug report: the release desktop build ships no
    // devtools, so the console alone is a sink with no reader (#1439). The
    // console line itself is unchanged.
    logClientWarning("wizard", "clipboard write failed", err);
    result = "Couldn't copy — select the commands above";
  }
  // THIS is the load-bearing guard: `writeText` spans real tasks, so a user can
  // click the Cowork row while it is pending, and without this the superseded
  // continuation both blanks a region it no longer owns and lands a stale
  // "Copied" in it. Pinned by "drops a copy result that lands after the user has
  // left for the sub-view".
  if (mine !== copyToken) return;
  // Clear and flush before the outcome: a second click with the SAME outcome
  // would otherwise re-assign an identical string, mutate no text node, and
  // announce nothing — so the user clicks the retry the failure message asks
  // for and hears silence.
  pluginCopyResult = "";
  await tick();
  // Defensive, and unreachable today: every `copyToken` mutator is an `onclick`,
  // a click is a task, and the gap above is a microtask — so nothing can
  // supersede across it. Kept because it costs one line and Svelte's async mode
  // would make `tick()` span a task, at which point it becomes the load-bearing
  // one. Deliberately NOT tested: reaching it needs a synthetic click dispatched
  // inside a microtask flush, which pins an interleaving no user can produce.
  if (mine !== copyToken) return;
  pluginCopyResult = result;
}

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

/** Enter the Cowork sub-view and pre-flight subnet detection (#1298).
 *
 *  Unlike the other two Enable surfaces this one has no confirm step — the
 *  button in the footer fires the real enable directly — so the probe hangs off
 *  view entry instead. Same contract as the other two: only a structured
 *  firewall error swaps the button for a retry; a probe that could not run
 *  leaves the button alone rather than blocking an enable that would have
 *  worked — it only says so, and only when the failure was ours (#1436). */
function openCoworkView(): void {
  coworkError = null;
  coworkBusy = false;
  // Remount incoming — see the declaration. Bumping the token is what stops an
  // in-flight copy from writing its result after this clear.
  copyToken++;
  pluginCopyResult = "";
  view = "cowork";
  void coworkProbe.run();
}

/** Leave the sub-view, abandoning any probe still in flight.
 *
 *  Load-bearing, not hygiene: `run()` deliberately does NOT clear `preflight`
 *  (clearing it would unmount the retry button mid-re-probe), so `reset()` is
 *  the only thing that does. Every exit from the sub-view must come through
 *  here or a stale hint paints on re-entry. */
function leaveCoworkView(): void {
  coworkProbe.reset();
  view = "main";
}

/** Enable Cowork. `cowork-enable-confirm-btn` is the SOLE caller — never the
 *  footer, never sub-view mount. On success (or UAC-declined, which the Rust
 *  side leaves fail-closed with enabled:false) we refetch and return to MAIN
 *  so the Cowork row reflects the committed outcome; a thrown firewall error
 *  (incl. adminDeclined) shows inline and keeps the user on the sub-view.
 *
 *  Same hazard as `CoworkSettings.svelte`'s `handleToggleOn`: `refetch()` can
 *  swallow its own failure and return without storing a fresh status. Leaving
 *  the sub-view on a failed read-back would paint `coworkRowDetail` from the
 *  stale pre-enable status on MAIN — "Let a teammate's Claude join…" over an
 *  integration that is actually now connected. Gate the return on the
 *  read-back succeeding; a failed one leaves the user on the sub-view, whose
 *  own copy is accurate, until a retry or the next poll catches up. */
async function enableCowork(): Promise<void> {
  coworkBusy = true;
  coworkError = null;
  try {
    const invoke: InvokeFn = await loadInvoke();
    // Degraded-success warnings (#1438) are not rendered here for the same
    // reason as `CoworkOnboardingStep`: a successful enable leaves this
    // sub-view, so a caveat shown now is discarded unread, and the per-workspace
    // facts behind it return on every status read for the settings panel to
    // show. Discarding the payload is a decision here, not an oversight.
    await coworkToggleIntegration(invoke, true);
    const readBack = await coworkStatus.refetch();
    if (readBack) leaveCoworkView();
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
  // Same reason as `openCoworkView`: `wizard.reset()` sets `step = "connect"`,
  // and the push-routes block gates on `step === "done"` — so leaving "done" is
  // what unmounts it, not the `detecting` flag `reset()` also clears.
  copyToken++;
  pluginCopyResult = "";
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

// See computeDoneHeaderState — the honesty contract lives in the pure helper
// (unit-tested); this derived just feeds it the two live inputs.
const doneHeaderState = $derived(
  computeDoneHeaderState(anyApplyErrors, reachability.claudeConnected),
);

/** Per-row delivery truth, joined the same way `resultLabel` joins the label.
 *  Static (a fact of the target kind), so unlike `reachabilityLine` it needs no
 *  probe and cannot be wrong about a running system. */
function pushSupportNoteFor(id: string): PushSupportNote | null {
  return pushSupportNote(wizard.picked.find((p) => p.id === id)?.config.kind);
}
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
        {reachability.claudeConnected
          ? "Claude connected just now"
          : "Server's up — restart Claude and run /mcp to connect it"}
      {:else if status === "unreachable"}
        Config written, but the Tandem MCP server isn't responding — start Tandem, then restart
        Claude.
      {:else}
        Tandem starts when Claude Desktop opens
      {/if}
    </span>
  {/if}
{/snippet}

<!-- Renders ONLY on a structural "nothing can notify this client" (today:
     Claude Desktop). There is deliberately no affirmative counterpart — see
     `pushSupportNote`. -->
{#snippet pushSupportLine(id: string)}
  {@const note = pushSupportNoteFor(id)}
  {#if note}
    <span
      class="iw-push-support"
      data-testid="integration-wizard-push-support-{id}"
      data-push-support="none"
    >
      {note.text}
    </span>
  {/if}
{/snippet}

<!-- The two push routes that need no flag, in the order `doctor.ts` and
     `README.md` recommend them. Rendered ONCE, above the registered/unregistered
     `{#if}` rather than inside either arm — which is the fix for #1389, whose
     defect was the registered arm implying that registering the shim takes the
     built-in watch away. It does not.

     Deliberately avoids "every session" in any form. The plugin genuinely does
     apply to every session once installed, but it arms on skill dispatch rather
     than at session start, and `tests/docs/monitor-arming-claims.test.ts` scores
     that claim per LINE — a sentence that reads honestly here is one wrap away
     from an unqualified promise. Saying when it starts and leaving the scope
     implied is both shorter and not the thing that keeps breaking. -->
{#snippet pushRoutes()}
  <p>
    <strong>The built-in Monitor watch</strong> installs nothing and needs no flag: on first
    Tandem use, Tandem's bundled skill reads the wake address from Claude's first
    <code class="iw-code-inline">tandem_status</code> and starts it for that session. It needs a
    Claude Code that offers a built-in Monitor tool — that is granted per account rather than per
    version, so upgrading will not add it, and on Windows it also needs Git Bash.
  </p>
  <p>
    <strong>The Tandem plugin</strong> needs no flag either. It starts watching the first time
    Claude uses Tandem's skill, so ask for Tandem by name rather than expecting it to be listening
    beforehand, and launch <code class="iw-code-inline">claude</code> from a terminal so it can
    find Node. It reads the same per-account gate as the built-in Monitor, so it cannot cover for
    that gate being off — but it does not need Git Bash. It also needs Claude Code 2.1.212 or
    newer: on anything older the install succeeds and the monitor simply never runs, with nothing
    to tell you so.
  </p>
  <!-- #1390: shown rather than run — see `CLAUDE_PLUGIN_INSTALL_COMMANDS` for
       why. Before this they were printed by `tandem setup` alone, which a
       desktop-app user never runs. -->
  <div class="iw-plugin-install" data-testid="integration-wizard-plugin">
    <pre class="iw-plugin-commands" data-testid="integration-wizard-plugin-commands">{PLUGIN_INSTALL_TEXT}</pre>
    <button
      type="button"
      class="iw-btn iw-btn-secondary iw-plugin-copy-btn"
      data-testid="integration-wizard-plugin-copy"
      onclick={() => void copyPluginCommands()}
    >
      Copy
    </button>
  </div>
  <p class="iw-hint-text" role="status" data-testid="integration-wizard-plugin-copy-status">
    {pluginCopyResult}
  </p>
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
            <!-- #1376: mounted-before-populated, and the two children are
                 additive. `useCoworkPreflight.svelte.ts` explains both and is
                 the one place that should.

                 `display: contents` rather than a box: unlike the other two
                 surfaces, this wrapper's parent (`.iw-step`) is a flex column
                 with a `gap`, and a gap applies between items regardless of
                 their size — so an always-mounted empty wrapper would sit there
                 as a permanent `--tandem-space-4` of dead air.

                 `:empty` and `display: none` are both wrong here. `:empty`
                 because the two `{#if}` blocks compile to two `<!>` anchors on
                 separate source lines, and the WHITESPACE between them is a
                 text node — `:empty` ignores comments but not that, so the
                 wrapper never matches. (Joining the source lines would fix the
                 selector and is not worth the fragility.) `display: none`
                 because it takes a live region back OUT of the accessibility
                 tree, restoring the exact bug at the exact moment content
                 arrives.

                 `display: contents` has its own history of dropping elements
                 from the a11y tree; Chromium has exposed them since 89 and
                 this sub-view is WebView2-only (gated on `isTauriRuntime()`
                 and an `osSupported` Cowork status), so the WebKit path never
                 renders it. Re-check before reusing this on a surface macOS
                 can reach. -->
            <div
              class="iw-preflight-live"
              role="status"
              data-testid="integration-wizard-cowork-preflight-live"
            >
              {#if coworkProbe.preflight?.status === "blocked"}
                <!-- #1298: detection already failed once here; say why rather
                     than leaving an Enable button that repeats it. -->
                <div
                  class="iw-banner-warning"
                  data-testid="integration-wizard-cowork-preflight-blocked"
                >
                  {@render warningIcon()}
                  <span>{coworkProbe.preflight.hint}</span>
                </div>
              {:else if coworkProbe.preflight?.status === "failed"}
                <!-- #1436: see the note in CoworkSettings. `iw-hint-text`
                     rather than `iw-banner-warning` on purpose — the claim is
                     "we don't know", not "this will fail". -->
                <p
                  class="iw-hint-text"
                  data-testid="integration-wizard-cowork-preflight-failed"
                >
                  {COWORK_PREFLIGHT_FAILED}
                </p>
              {/if}
              {#if coworkProbe.probing}
                <p class="iw-hint-text">{COWORK_PREFLIGHT_CHECKING}</p>
              {/if}
            </div>
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
            {#if showShimWarning}
              <div
                class="iw-banner-warning"
                role="alert"
                data-testid="integration-wizard-shim-warning"
              >
                {@render warningIcon()}
                <span>
                  The <code>claude</code> on your PATH was installed with npm, which leaves a
                  wrapper Tandem's launcher can't start — it works in a terminal, but Tandem
                  can't start Claude for you. Reinstall Claude Code from
                  <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer"
                    >claude.com/claude-code</a
                  > to fix it, then restart Tandem — its launcher reads the PATH it started
                  with, so a fresh install stays invisible until then. Connecting here still
                  works if you launch Claude yourself.
                </span>
              </div>
            {/if}
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
                <code class="iw-code">{MCP_BASE_URL}/mcp</code>
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
              {#if doneHeaderState === "connected"}
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
              {:else if doneHeaderState === "waiting"}
                <svg
                  class="iw-done-waiting"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
              {:else}
                {@render warningIcon("iw-done-waiting")}
              {/if}
              <h3 class="iw-done-title">
                {#if doneHeaderState === "connected"}
                  Claude is connected to Tandem
                {:else if doneHeaderState === "waiting"}
                  Config written — waiting for Claude to connect
                {:else}
                  Partly connected
                {/if}
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
                        {@render pushSupportLine(result.id)}
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
            {#if isTauriRuntime() && wizardAutostartStatus !== null && !wizardAutostartBlocked}
              <label class="iw-autostart" data-testid="integration-wizard-autostart">
                <input
                  type="checkbox"
                  data-testid="integration-wizard-autostart-toggle"
                  checked={wizardAutostartStatus.enabled}
                  disabled={wizardAutostart.loading}
                  onchange={(e) => void toggleWizardAutostart(e.currentTarget)}
                />
                <span>
                  <span class="iw-autostart-title">Start Tandem when my computer starts</span>
                  <span class="iw-autostart-sub">
                    So Tandem is already running when you ask Claude to open a document — if it
                    isn't, Claude starts with no Tandem tools at all. Starts minimized to the
                    tray; your AI assistant isn't launched until you open the window.
                  </span>
                </span>
              </label>
              {#if wizardAutostart.error}
                <div class="iw-autostart-error" data-testid="integration-wizard-autostart-error">
                  {wizardAutostart.error}
                </div>
              {/if}
            {/if}
            {#if wizard.channelRegistered !== null && whatsNext !== "stdio-only"}
              <div
                class="iw-push-mode"
                data-testid="integration-wizard-push-mode"
                data-push-mode={wizard.channelRegistered ? "shim" : "no-shim"}
              >
                <p>
                  Sessions Tandem starts for you are woken directly and need nothing further. A
                  session you start yourself sees your comments and messages when it next checks
                  its inbox; to have it react as they happen, use one of these — not several.
                </p>
                {@render pushRoutes()}
                {#if wizard.channelRegistered}
                  <p>
                    The channel shim is registered here, and it is the one route that needs
                    neither of those. Registration alone does not switch it on, though: start the
                    session with
                    <code class="iw-code-inline"
                      >claude --dangerously-load-development-channels server:tandem-channel</code
                    >.
                  </p>
                {:else}
                  <p>
                    If Claude reports no Monitor tool at all, come back here and register the
                    channel shim — it is the one route that depends on neither gate, at the cost
                    of a flag on every session you start.
                  </p>
                {/if}
              </div>
            {/if}
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
                      onclick={openCoworkView}
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
              {:else}
                <div class="iw-more-row">
                  <div class="iw-more-row-text">
                    <span class="iw-more-row-name">AI models</span>
                    <span class="iw-more-row-detail">Set up a local AI model (Ollama or llama.cpp)</span>
                  </div>
                  <button
                    type="button"
                    class="iw-btn iw-btn-secondary iw-more-btn"
                    onclick={() => {
                      onClose();
                      onSetupModels?.();
                    }}
                    aria-label="Set up a local AI model"
                    data-testid="integration-wizard-models-setup"
                  >
                    Set up
                  </button>
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
            onclick={leaveCoworkView}
            data-testid="integration-wizard-cowork-back"
            disabled={coworkBusy}
          >
            Back
          </button>
          {#if coworkStatus.status?.enabled}
            <button type="button" class="iw-btn iw-btn-primary" onclick={leaveCoworkView}>
              Done
            </button>
          {:else if coworkProbe.preflight?.status === "blocked"}
            <button
              type="button"
              class="iw-btn iw-btn-primary"
              onclick={() => void coworkProbe.run()}
              disabled={coworkBusy || coworkProbe.probing}
              data-testid="integration-wizard-cowork-preflight-retry-btn"
            >
              {coworkProbe.probing ? "Checking…" : "Check again"}
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

  .iw-autostart {
    display: flex;
    align-items: flex-start;
    gap: var(--tandem-space-2);
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface-sunk);
    cursor: pointer;
  }
  .iw-autostart input {
    accent-color: var(--tandem-accent);
    margin-top: 2px;
    flex-shrink: 0;
  }
  .iw-autostart-title {
    display: block;
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg);
  }
  .iw-autostart-sub {
    display: block;
    margin-top: 2px;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }
  .iw-autostart-error {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-error-fg);
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
  /* Inherits the banner's warning foreground rather than --tandem-accent (the
     convention in neutral surfaces): accent-on-warning-bg loses the contrast
     the banner's own palette is tuned for. Underline carries the affordance. */
  .iw-banner-warning a {
    color: inherit;
    text-decoration: underline;
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
  /* The not-yet-connected / partial header glyph — deliberately NOT green, so a
     "waiting" / "partly connected" headline never sits under a success check. */
  .iw-done-waiting {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    color: var(--tandem-fg-muted);
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

  /* Muted, not `warning`. Nothing is broken or misconfigured — this is how the
     client works — and colouring it as a fault would say the opposite of the
     "Connected" line directly above it. Matches the neutral tone of the
     `no-push` send notice, which is `info` for the same reason. */
  .iw-push-support {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
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

  /* Push-routes readout. ONE treatment for both arms since #1389: the old
     green/grey split tinted "configured" vs "polling", which read as
     configured-vs-degraded, and the unregistered arm is neither — it now leads
     with two push routes that need no shim at all. */
  .iw-push-mode {
    margin-top: var(--tandem-space-2);
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border-radius: var(--tandem-r-3);
    font-size: var(--tandem-text-xs);
    line-height: 1.5;
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg-muted);
  }
  /* The block is now several paragraphs rather than one sentence; scoped so it
     cannot reach the `<p>`s in the Cowork sub-view. */
  .iw-push-mode p {
    margin: 0 0 var(--tandem-space-2);
  }
  .iw-push-mode p:last-child {
    margin-bottom: 0;
  }
  .iw-plugin-install {
    display: flex;
    align-items: flex-start;
    gap: var(--tandem-space-2);
    margin-bottom: var(--tandem-space-2);
  }
  .iw-plugin-commands {
    /* `min-width: 0` because a flex item's automatic minimum size is
       min-content, and these are two unbreakable command lines — without it the
       <pre> refuses to shrink and pushes the button out of the dialog. */
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    padding: var(--tandem-space-2);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-xs);
    line-height: 1.6;
    background: var(--tandem-surface-sunk);
    border-radius: var(--tandem-r-2);
    overflow-x: auto;
  }
  .iw-plugin-copy-btn {
    flex: 0 0 auto;
  }
  /* See the markup comment: the parent is a gapped flex column, so a box here
     would cost a gap whenever the region is empty — which is most of the time. */
  .iw-preflight-live {
    display: contents;
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
