<script lang="ts">
/**
 * The three real-time-update routes, and the Tandem plugin's install commands.
 *
 * Extracted from `IntegrationWizardModal.svelte` for #1432. It renders in TWO
 * hosts — the wizard's Done screen and the persistent "Real-time updates"
 * section in Settings → AI Assistant — so the copy has one source rather than
 * one durable home and one that is destroyed when the wizard is dismissed.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT CARRY: the channel-shim paragraph.
 * It is route three, but its actionable half differs per host (the wizard can
 * report a just-read registration state; Settings reads its own), and both
 * arms must name `tandem setup --apply --with-channel-shim` because NEITHER
 * host can register it — see `shouldRegisterChannelShim` in
 * `server/integrations/apply.ts`, which returns `override ?? false`, and the
 * call-site comment in `integrations/api-routes.ts`. Each host writes its own.
 *
 * The `data-testid`s are the wizard's original strings, kept verbatim through
 * the move: Critical Rule 7 forbids removing a selector, and
 * `integration-wizard-push-support.test.ts` (the only consumer) pins #1376 and
 * #1390 through them. They read oddly in a Settings mount; that is the price of
 * not renaming, and the Settings-side tests query by role/text instead. The two
 * hosts never show this block simultaneously — the wizard renders it only under
 * `step === "done"` with `channelRegistered !== null`, which no Settings-open
 * path produces.
 *
 * Deliberately avoids "every session" in any form. The plugin genuinely does
 * apply to every session once installed, but it arms on skill dispatch rather
 * than at session start, and `tests/docs/monitor-arming-claims.test.ts` scores
 * that claim per LINE — a sentence that reads honestly here is one wrap away
 * from an unqualified promise. Saying when it starts and leaving the scope
 * implied is both shorter and not the thing that keeps breaking. (This file is
 * in that test's CARRIERS list; it followed the prose here.)
 */
import { tick } from "svelte";
import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../shared/constants.js";
import { logClientWarning } from "../utils/client-log.js";

// #1390: the plugin install commands, plus the outcome of the button that
// copies them. The outcome lives beside the button in its own live region
// rather than in the button's label — a changed accessible name on a button
// nobody is focused on is announced by nothing, which is the same mistake
// #1376 exists to fix.
const PLUGIN_INSTALL_TEXT = CLAUDE_PLUGIN_INSTALL_COMMANDS.join("\n");

/**
 * Outcome of the Copy button, announced from its own live region.
 *
 * MUST be `""` whenever this block (re)mounts — a live region created already
 * holding its text is announced by nothing, which is #1376's defect
 * reintroduced inside the fix for it.
 *
 * Since #1432 that is STRUCTURAL rather than maintained by hand. The state
 * lives in this component, and every transition that used to need an explicit
 * clear — `openCoworkView`, `retryDetection`, closing the wizard — destroys the
 * component, so a remount is a fresh `""` by construction. The wizard's two
 * manual `pluginCopyResult = ""` sites were deleted with the move; do not
 * reintroduce them here as an `$effect`.
 */
let pluginCopyResult = $state("");

/**
 * Monotonic ticket ordering two copies IN FLIGHT WITHIN ONE MOUNTED INSTANCE.
 *
 * NOT DEAD CODE, though its old job is gone: before #1432 it also stopped a
 * superseded continuation from writing into a region the user had navigated
 * away from, and that leg is now handled by destruction (see above). What
 * remains is same-instance ordering — the clipboard write spans real tasks, so
 * a second click's continuation can resolve before the first's, and without the
 * ticket the later-resolving stale result would land last and be announced.
 * `integration-wizard-push-support.test.ts`'s "drops a copy result that lands
 * after the user has left for the sub-view" still passes, but now through the
 * fresh-instance mechanism rather than through this counter.
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
    // console line itself is unchanged — `logClientWarning` emits
    // `[scope] event:` — so the `[push-routes]` prefix this component adopted in
    // #1432 is preserved, and the scope recorded in the client log is
    // `push-routes` for the same reason the prefix is: this block also renders
    // in Settings, where a log blaming "wizard" names a surface the user never
    // opened.
    logClientWarning("push-routes", "clipboard write failed", err);
    result = "Couldn't copy — select the commands above";
  }
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
</script>

<!-- The two push routes that need no flag, in the order `doctor.ts` and
     `README.md` recommend them. Rendered ONCE, above each host's
     registered/unregistered `{#if}` rather than inside either arm — which is the
     fix for #1389, whose defect was the registered arm implying that registering
     the shim takes the built-in watch away. It does not. -->
<div class="pr-routes">
  <p>
    Sessions Tandem starts for you are woken directly and need nothing further. A session you start
    yourself sees your comments and messages when it next checks its inbox; to have it react as
    they happen, use one of these — not several.
  </p>
  <p>
    <strong>The built-in Monitor watch</strong> installs nothing and needs no flag: on first
    Tandem use, Tandem's bundled skill reads the wake address from Claude's first
    <code class="pr-code-inline">tandem_status</code> and starts it for that session. It needs a
    Claude Code that offers a built-in Monitor tool — that is granted per account rather than per
    version, so upgrading will not add it, and on Windows it also needs Git Bash.
  </p>
  <p>
    <strong>The Tandem plugin</strong> needs no flag either. It starts watching the first time
    Claude uses Tandem's skill, so ask for Tandem by name rather than expecting it to be listening
    beforehand, and launch <code class="pr-code-inline">claude</code> from a terminal so it can
    find Node. It reads the same per-account gate as the built-in Monitor, so it cannot cover for
    that gate being off — but it does not need Git Bash. It also needs Claude Code 2.1.212 or
    newer: on anything older the install succeeds and the monitor simply never runs, with nothing
    to tell you so.
  </p>
  <!-- #1390: shown rather than run — see `CLAUDE_PLUGIN_INSTALL_COMMANDS` for
       why. Before this they were printed by `tandem setup` alone, which a
       desktop-app user never runs. #1432 moved them off the wizard's one-shot
       Done screen so they survive dismissing it. -->
  <div class="pr-plugin-install" data-testid="integration-wizard-plugin">
    <pre class="pr-plugin-commands" data-testid="integration-wizard-plugin-commands">{PLUGIN_INSTALL_TEXT}</pre>
    <button
      type="button"
      class="pr-copy-btn"
      data-testid="integration-wizard-plugin-copy"
      onclick={() => void copyPluginCommands()}
    >
      Copy
    </button>
  </div>
  <p class="pr-hint-text" role="status" data-testid="integration-wizard-plugin-copy-status">
    {pluginCopyResult}
  </p>
</div>

<style>
  /* Self-sufficient by design. Svelte compiles every selector with the
     DECLARING component's scope hash, so nothing in IntegrationWizardModal's
     <style> reaches these nodes — the prose recipes below are copies of
     `.iw-hint-text` / `.iw-code-inline` / `.iw-plugin-*`, which is why this file
     must be re-checked if those move. The button is the ONE deliberate
     divergence (see `.pr-copy-btn`). The root pins the type the wizard's
     `.iw-push-mode` box used to supply by inheritance, so the prose renders
     identically there and needs no host typography in Settings. */
  .pr-routes {
    font-size: var(--tandem-text-xs);
    line-height: 1.5;
    color: var(--tandem-fg-muted);
  }
  /* No `:last-child` reset here on purpose: in BOTH hosts a channel-shim
     paragraph follows this component, so the trailing gap is wanted, and the
     host's own last paragraph is host-authored and still governed by the host's
     rule. */
  .pr-routes p {
    margin: 0 0 var(--tandem-space-2);
  }

  .pr-code-inline {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-xs);
    background: var(--tandem-surface-sunk);
    padding: 1px 4px;
    border-radius: var(--tandem-r-2);
  }

  .pr-hint-text {
    font-size: var(--tandem-text-sm);
    line-height: 1.5;
    color: var(--tandem-fg-muted);
    margin: 0;
  }

  /* HOST-NEUTRAL, deliberately not the wizard's `.iw-btn` recipe.
     The extraction originally carried `.iw-btn` + `.iw-btn-secondary` across
     verbatim (13px / `space-4` / `border-strong` / `surface`, weight 500), which
     is the modal's button scale. In its second host that is one size and one
     weight above every other control on the Settings tab — the sibling "Reopen
     integration wizard…" and working-directory buttons are 12px, `space-2
     space-3`, `border`, `surface-muted` — so the button, and only the button,
     read as imported chrome. The prose around it already matches the tab
     (`.pr-routes` 11px == `.settings-hint` 11px), so the recipe below is the
     Settings scale.
     Consequence in the OTHER host, accepted rather than unnoticed: on the
     wizard's Done screen this Copy button is now a step smaller than the modal's
     footer buttons. It sits in a flex row with the 11px `<pre>` of commands, not
     beside those footer buttons, so it reads as a control on that row.
     One recipe, not a base + variant pair: there is exactly one button here. */
  .pr-copy-btn {
    flex: 0 0 auto;
    padding: var(--tandem-space-2) var(--tandem-space-3);
    font-size: var(--tandem-text-sm);
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }
  .pr-copy-btn:hover {
    background: var(--tandem-surface-sunk);
  }
  .pr-copy-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
  }

  .pr-plugin-install {
    display: flex;
    align-items: flex-start;
    gap: var(--tandem-space-2);
    margin-bottom: var(--tandem-space-2);
  }
  .pr-plugin-commands {
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
  /* Reduced motion: BOTH the OS preference and the in-app toggle, mirroring the
     wizard's pair. The transition above came with the button; the wizard's two
     neutralisers did not, because both compile with the wizard's scope hash.
     `body.tandem-reduce-motion` is a real setting (`reduceMotion`, applied in
     App.svelte) — dropping it here would silently un-honour it for this button
     alone. */
  @media (prefers-reduced-motion: reduce) {
    .pr-copy-btn {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .pr-copy-btn {
    transition: none;
  }
</style>
