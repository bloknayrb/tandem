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
 * **Every member is a getter, including the scalar `activeRailTab`.** A plain
 * value property is the failure this file is most exposed to: it returns the
 * correct string at every direct read, so a unit test that re-reads the model
 * after each mutation passes while template reactivity is completely dead —
 * the rail would stop switching and nothing but a rendered assertion would
 * notice. Never destructure this object at a call site, and never spread it:
 * both invoke the getters once and freeze the result.
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
  /** Pending-review count for the Annotations tab's badge; 0 while that tab is active. */
  readonly pendingAnnotationBadge: number;
  /** Toggle the left panel's persisted visibility. */
  toggleLeft(): void;
  /** Toggle the right panel; on show, also clears `soloRailHidden` in solo mode. */
  toggleRight(): void;
  /** Select a rail tab, tearing down a transient chat reveal unless the target is Chat. */
  selectRailTab(tab: RailTab): void;
  /** Show Annotations WITHOUT touching a transient chat reveal — see the note on the impl. */
  showAnnotations(): void;
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
  // load-bearing the moment anyone constructs this model from inside one.
  let activeRailTab = $state<RailTab>(
    untrack(() => settingsState.settings.primaryTab) === "chat" ? "chat" : "annotations",
  );

  // Zero while the Annotations tab is already showing: the badge exists to
  // advertise unreviewed work on the tab you are NOT looking at.
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

  function selectRailTab(tab: RailTab): void {
    if (tab !== "chat") opts.closeTransientChat();
    activeRailTab = tab;
  }

  /**
   * The raw write from `App.svelte`'s `onAnnotationClick`, preserved
   * byte-for-byte: it does NOT close a transient chat reveal, where
   * `selectRailTab("annotations")` does.
   *
   * This is not an alias and must not be collapsed into `selectRailTab`. Unit
   * 10b is a behaviour-preserving extraction, which is reason enough on its
   * own — but for the record, the difference is hard to observe: the
   * capture-phase window `pointerdown` listener App installs while a reveal is
   * open already closes it for any click outside the right rail, so on the
   * ordinary pointer path the reveal is gone before this runs. "Hard to
   * observe" is not "impossible" (a synthetic click, or a keyboard reveal
   * opened between pointerdown and click, reaches here with the reveal live),
   * and an extraction is the wrong place to bet on the difference either way.
   *
   * Unifying the two is Unit 10c's call, once chat-reveal ownership moves.
   */
  function showAnnotations(): void {
    activeRailTab = "annotations";
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
    showAnnotations,
  };
}
