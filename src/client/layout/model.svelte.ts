/**
 * Layout model (ADR-037).
 *
 * Owns both rails' **persisted** visibility (with solo-mode suppression and
 * the toggles) and, since Unit 10b, the right rail's tab *selection* — which
 * of its two fixed tabs is showing, plus the pending-annotation badge.
 *
 * **`rightVisible` is the persisted half only, not "the rail is on screen".**
 * Effective on-screen visibility is
 * `rightVisible || railFloat.right || railFloatClosing.right || chatReveal`,
 * and the three float/reveal terms live in `App.svelte` (Unit 10c's
 * territory). A consumer that reads `rightVisible` as "visible to the user"
 * is wrong in exactly the states 10c exists to own.
 *
 * Returned shape uses getters so consumers see reactivity through the
 * settings store underneath — same pattern as `useTandemSettings.svelte.ts`.
 *
 * **Every reactive VALUE is a getter, including the scalar `activeRailTab`.**
 * (The four actions are plain function properties.) A plain value property is
 * the failure this file is most exposed to: it returns the correct answer at
 * every direct read, so a unit test that re-reads the model after each
 * mutation passes while template reactivity is completely dead — the rail
 * would stop switching and nothing but a rendered assertion would notice, or,
 * in a unit test, an effect that subscribes to the member and records what it
 * sees. Four specs in `tests/client/layout-model.svelte.test.ts` do that, one
 * per reactive value. Two things they must keep doing, both learned by running
 * the mutants: re-reading the value cannot discriminate, not even through a
 * local `$derived` (the compiler warns such a local captures only its initial
 * value); and the RUN COUNT alone cannot either. A getter that still performs
 * a tracked read while returning a frozen value passes `expect(runs).toBe(2)`
 * and fails only on the recorded values — and since `settings` is a
 * whole-object signal reassigned on every write, any tracked read of it
 * re-runs the effect on an unrelated theme change. Never reduce one of those
 * specs to a bare run count.
 * Never destructure this object at a call site, and never spread it: both
 * invoke the getters once and freeze the result.
 *
 * Wave I removed the cross-rail tab picker. The left rail is hard-coded to
 * the outline; the right rail is hard-coded to Annotations + Chat. The
 * `leftTabs` / `rightTabs` getters and `moveTabs` action are gone, and they
 * are not what Unit 10b brought back: `activeRailTab` selects between two
 * fixed tabs, it does not move a tab between rails.
 */

import { untrack } from "svelte";
import type { Annotation } from "../../shared/types.js";
import { isPendingReviewTarget } from "../../shared/types.js";
import type { PrimaryTab } from "../hooks/useTandemSettings.js";
import type { TandemSettingsState } from "../hooks/useTandemSettings.svelte.js";

/**
 * The right rail's two fixed tabs.
 *
 * An alias rather than its own union: `PrimaryTab` is the same two literals,
 * and the persisted `primaryTab` setting seeds this. Re-declaring it would
 * leave two unions that nothing keeps in sync. The alias exists because
 * "which tab is selected" and "which tab the user prefers to open on" read
 * differently at their use sites even though the sets coincide.
 */
export type RailTab = PrimaryTab;

/** Sliver of the mode store the layout model needs. */
export interface LayoutModeStateLike {
  readonly tandemMode: "solo" | "tandem";
}

export interface LayoutModelOptions {
  settingsState: TandemSettingsState;
  modeState: LayoutModeStateLike;
  /**
   * Live annotation list — the same source `App.svelte` hands the review hook.
   *
   * Deliberately not `review.getReviewTargets()`, which computes the identical
   * filter: routing the badge through the review hook would couple this model
   * to a module Unit 10c is about to restructure. What is worth sharing is the
   * `isPendingReviewTarget` predicate, and both sites already import it.
   *
   * A third option exists and was not taken: injecting `getPendingCount:
   * () => number` and keeping the definition of "pending" out of a layout
   * module entirely. That is arguably the cleaner boundary — it is the only
   * reason this file imports from `shared/types` at all. It loses on testing:
   * the filter would move inline into `App.svelte`, where nothing covers it,
   * and moving an untested expression out of reach is the opposite of this
   * unit's point. Revisit when Unit 10c reshapes review coordination.
   */
  getAnnotations: () => Annotation[];
  /**
   * Tear down a transient chat reveal. Owned by `App.svelte` today, by Unit
   * 10c later — which is why it is injected rather than moved.
   *
   * REQUIRED, not optional. On master the close was an unconditional call
   * inside `selectRailTab`, so an optional callback would let a future
   * consumer drop a reveal teardown with no signal.
   */
  closeTransientChat: () => void;
}

export interface LayoutModel {
  /** Effective visibility (`settings.leftPanelVisible`, no solo override on the left). */
  readonly leftVisible: boolean;
  /** Effective visibility — `settings.rightPanelVisible && !(solo && soloRailHidden)`. */
  readonly rightVisible: boolean;
  /** Which of the right rail's two fixed tabs is selected. */
  readonly activeRailTab: RailTab;
  /** Badge value for the Annotations tab: pending review targets, or 0 while that tab is
   *  active. Not a count of pending annotations — see the note at the derivation. */
  readonly pendingAnnotationBadge: number;
  /** Toggle the left panel's persisted visibility. */
  toggleLeft(): void;
  /** Toggle the right panel; on show, also clears `soloRailHidden` in solo mode. */
  toggleRight(): void;
  /** Select a rail tab, tearing down a transient chat reveal unless the target is Chat. */
  selectRailTab(tab: RailTab): void;
}

export function createLayoutModel(opts: LayoutModelOptions): LayoutModel {
  const { settingsState, modeState } = opts;

  const leftVisible = $derived(settingsState.settings.leftPanelVisible);
  const rightVisible = $derived(
    settingsState.settings.rightPanelVisible &&
      !(modeState.tandemMode === "solo" && settingsState.settings.soloRailHidden),
  );

  // Seeded ONCE from the persisted `primaryTab` preference, never derived from
  // it. `settingsState.settings` is wholesale-reassigned on every settings
  // write, so a `$derived` here would recompute on a theme change, a hue drag,
  // a font pick or a shortcut remap — yanking the user out of Chat mid-message
  // on input that has nothing to do with rail tabs. `untrack` is belt-and-
  // braces at today's call site (a factory body is not a reaction) and becomes
  // load-bearing the moment anyone constructs this model from inside one --
  // which is not hypothetical cover for an unpinned guard: a spec builds the
  // model inside an `$effect` and writes an unrelated key, and removing
  // `untrack` turns it red.
  let activeRailTab = $state<RailTab>(
    untrack(() => settingsState.settings.primaryTab) === "chat" ? "chat" : "annotations",
  );

  // Zero while the Annotations tab is already showing: the badge exists to
  // advertise unreviewed work on the tab you are NOT looking at.
  //
  // So this is a BADGE value, not a count of pending annotations, and the name
  // has to keep carrying that. A future consumer that reads this member as
  // "how many are pending" — a peek, a taskbar badge, a status line — gets 0
  // exactly when the user happens to be on Annotations, silently. Today the
  // template guards it with the same `activeRailTab !== "annotations"` test
  // (`App.svelte`), so the zeroing is double-covered and unobservable.
  //
  // Its sibling `chatState.unreadCount` is the contrast worth knowing, and it
  // is subtler than "one zeroes and one does not". That `$derived`
  // (`useChatState.svelte.ts`) has no tab branch, so the VALUE is never
  // synthesised to zero — but an `$effect` there calls
  // `acknowledgeVisibleMessages` whenever `getVisible()` (wired to
  // `chatVisible`) is true, so an on-screen Chat tab still drives it to 0,
  // through `seenIds` rather than a ternary. `chat-unread-peek` works anyway
  // because it renders only while `!effectiveRightVisible` — precisely when
  // `chatVisible` is false and nothing acknowledges. Do not copy either
  // mechanism without checking which one you actually need.
  const pendingAnnotationBadge = $derived(
    activeRailTab === "annotations"
      ? 0
      : opts.getAnnotations().filter(isPendingReviewTarget).length,
  );

  function toggleLeft(): void {
    settingsState.updateSettings({
      leftPanelVisible: !settingsState.settings.leftPanelVisible,
    });
  }

  function toggleRight(): void {
    if (rightVisible) {
      settingsState.updateSettings({ rightPanelVisible: false });
      return;
    }
    settingsState.updateSettings({
      rightPanelVisible: true,
      ...(modeState.tandemMode === "solo" ? { soloRailHidden: false } : {}),
    });
  }

  /**
   * Select a rail tab, then tear down any transient chat reveal.
   *
   * **The order is the point, and it changed in Unit 10c.** 10b preserved
   * master byte-for-byte, where the closer ran FIRST — so a closer that threw
   * ate the user's click entirely: no tab switch, no toast, no warn. The tab
   * write is the user's intent and the teardown is bookkeeping, so the intent
   * lands first now and a throwing closer costs a stale reveal rather than the
   * whole interaction.
   */
  function selectRailTab(tab: RailTab): void {
    activeRailTab = tab;
    if (tab !== "chat") opts.closeTransientChat();
  }

  return {
    get leftVisible() {
      return leftVisible;
    },
    get rightVisible() {
      return rightVisible;
    },
    get activeRailTab() {
      return activeRailTab;
    },
    get pendingAnnotationBadge() {
      return pendingAnnotationBadge;
    },
    toggleLeft,
    toggleRight,
    selectRailTab,
  };
}
