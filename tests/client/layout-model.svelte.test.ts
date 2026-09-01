/**
 * Tests for the ADR-037 LayoutModel.
 *
 * Two invariant families: panel visibility (with solo-mode suppression) and
 * the toggles, plus — since Unit 10b — right-rail tab selection and the
 * pending-annotation badge. Wave I removed the cross-rail tab picker; the
 * `moveTabs` tests are gone with it, and `activeRailTab` is NOT its return:
 * it selects between two fixed tabs, it does not move a tab between rails.
 *
 * The model takes a settings store + a mode-state-like shape; we stub both
 * with plain Svelte 5 `$state` so the test exercises the reactive contract
 * end-to-end without pulling in `useTandemSettings`.
 *
 * **Two harness rules, both learned the expensive way in Unit 10a.**
 *
 * 1. Anything the model derives from must be `$state` here. A derivation whose
 *    sources are inert computes once and caches forever, so a harness that is
 *    inert where production is reactive cannot see a derivation lose its
 *    dependency — it just goes green on a stale value.
 * 2. Construct the model ONCE per spec, before any mutation. A spec that
 *    rebuilds the model after mutating cannot tell a live derivation from a
 *    frozen one, because a fresh model computes the right answer either way.
 */

import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import type {
  TandemSettings,
  TandemSettingsState,
} from "../../src/client/hooks/useTandemSettings.svelte.js";
import { createLayoutModel } from "../../src/client/layout/model.svelte.js";
import type { Annotation } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

function makeSettingsState(initial: Partial<TandemSettings>): TandemSettingsState {
  let settings = $state<TandemSettings>({
    // Minimal defaults — only the fields the layout model reads matter for tests.
    leftPanelVisible: true,
    rightPanelVisible: true,
    soloRailHidden: false,
    primaryTab: "annotations",
    showAuthorship: true,
    theme: "system",
    textSize: "md",
    density: "comfortable",
    editorFont: "serif",
    editorWidthPx: 720,
    panelOrder: "left-first",
    dwellTimeMs: 1000,
    degradedBannerDelayMs: 5000,
    sidecarRetryStrategy: "exponential",
    networkHoldAnnotations: false,
    reduceMotion: false,
    ...initial,
  } as TandemSettings);

  return {
    get settings() {
      return settings;
    },
    updateSettings(partial: Partial<TandemSettings>) {
      settings = { ...settings, ...partial };
    },
  };
}

/**
 * Rail-tab dependencies for the specs that do not exercise them.
 *
 * `getAnnotations` returns a fresh empty array rather than a shared constant
 * so a spec can never mutate another's fixture.
 */
function railTabStubs() {
  return {
    getAnnotations: () => [] as Annotation[],
    closeTransientChat: () => {},
  };
}

/** A rail-tab harness whose annotation list is genuinely reactive. */
function makeRailHarness(
  initial: { primaryTab?: "annotations" | "chat"; annotations?: Annotation[] } = {},
) {
  const settings = makeSettingsState({ primaryTab: initial.primaryTab ?? "annotations" });
  // `$state`, not a plain array: see harness rule 1 in the file header.
  let annotations = $state<Annotation[]>(initial.annotations ?? []);
  const closeCalls: string[] = [];
  const model = createLayoutModel({
    settingsState: settings,
    modeState: { tandemMode: "tandem" },
    getAnnotations: () => annotations,
    closeTransientChat: () => closeCalls.push("close"),
  });
  return {
    model,
    settings,
    closeCalls,
    setAnnotations(next: Annotation[]) {
      annotations = next;
    },
  };
}

/**
 * A pending annotation that `isPendingReviewTarget` accepts.
 *
 * `makeAnnotation` already defaults to `author: "claude" / type: "comment" /
 * status: "pending"`, so this is just an id. The hand-rolled literal it
 * replaces had `range: { start, end }` where the type is `{ from, to }` — a
 * shape error a double cast hid, and which only went unnoticed because
 * `isPendingReviewTarget` never reads the range.
 */
function pending(id: string): Annotation {
  return makeAnnotation({ id });
}

describe("LayoutModel visibility", () => {
  it("leftVisible mirrors settings.leftPanelVisible", () => {
    const settings = makeSettingsState({ leftPanelVisible: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    expect(model.leftVisible).toBe(true);

    settings.updateSettings({ leftPanelVisible: false });
    expect(model.leftVisible).toBe(false);
  });

  it("rightVisible is true when settings.rightPanelVisible and not solo-hidden", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: false });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    expect(model.rightVisible).toBe(true);
  });

  it("rightVisible is suppressed in solo mode when soloRailHidden is set", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "solo" },
      ...railTabStubs(),
    });
    expect(model.rightVisible).toBe(false);
  });

  it("rightVisible stays true in tandem mode even when soloRailHidden is set", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    expect(model.rightVisible).toBe(true);
  });
});

describe("LayoutModel.toggleLeft", () => {
  it("flips leftPanelVisible", () => {
    const settings = makeSettingsState({ leftPanelVisible: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    model.toggleLeft();
    expect(settings.settings.leftPanelVisible).toBe(false);
    model.toggleLeft();
    expect(settings.settings.leftPanelVisible).toBe(true);
  });
});

describe("LayoutModel.toggleRight", () => {
  it("hides the right panel when currently visible", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: false });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(false);
  });

  it("shows the right panel and clears soloRailHidden in solo mode", () => {
    const settings = makeSettingsState({ rightPanelVisible: false, soloRailHidden: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "solo" },
      ...railTabStubs(),
    });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(true);
    expect(settings.settings.soloRailHidden).toBe(false);
  });

  it("does NOT touch soloRailHidden when toggling on in tandem mode", () => {
    const settings = makeSettingsState({ rightPanelVisible: false, soloRailHidden: true });
    const model = createLayoutModel({
      settingsState: settings,
      modeState: { tandemMode: "tandem" },
      ...railTabStubs(),
    });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(true);
    expect(settings.settings.soloRailHidden).toBe(true);
  });
});

describe("LayoutModel rail-tab selection", () => {
  it("seeds activeRailTab from the persisted primaryTab preference", () => {
    expect(makeRailHarness({ primaryTab: "chat" }).model.activeRailTab).toBe("chat");
    expect(makeRailHarness({ primaryTab: "annotations" }).model.activeRailTab).toBe("annotations");
  });

  it("does NOT track primaryTab after construction", () => {
    // The seed is deliberately one-shot. `settingsState.settings` is
    // wholesale-reassigned on every settings write, so a `$derived` seed would
    // fire on a theme change or a hue drag and yank the user out of Chat
    // mid-message. Changing the preference must not move the current tab.
    const h = makeRailHarness({ primaryTab: "annotations" });
    h.model.selectRailTab("chat");
    h.settings.updateSettings({ primaryTab: "annotations" });
    expect(h.model.activeRailTab).toBe("chat");
  });

  it("re-runs a subscribed effect when the tab changes", () => {
    // Pins the getter invariant in the model's file header (a plain value
    // property instead of a getter). Counting effect RUNS is what separates
    // the two: an effect subscribed to a getter re-runs on write; an effect
    // that read a frozen string subscribed to nothing and never runs again.
    // Reading the value back does NOT discriminate, not even through a local
    // `$derived` — the compiler warns that such a local captures only its
    // initial value, which is the same blindness this spec exists to catch.
    const h = makeRailHarness({ primaryTab: "annotations" });
    let runs = 0;
    const seen: string[] = [];
    const dispose = $effect.root(() => {
      $effect(() => {
        runs += 1;
        seen.push(h.model.activeRailTab);
      });
    });
    flushSync();
    expect(runs).toBe(1);

    h.model.selectRailTab("chat");
    flushSync();
    expect(runs).toBe(2);
    expect(seen).toEqual(["annotations", "chat"]);
    dispose();
  });

  it("closes a transient chat reveal when selecting Annotations", () => {
    const h = makeRailHarness({ primaryTab: "chat" });
    h.model.selectRailTab("annotations");
    expect(h.model.activeRailTab).toBe("annotations");
    expect(h.closeCalls).toEqual(["close"]);
  });

  it("does NOT close a transient chat reveal when selecting Chat", () => {
    // `App.svelte`'s guard is `if (tab !== "chat")`, so selecting Chat leaves a
    // reveal open — the caller is usually about to open one. This is why there
    // is no separate `showChat()`: it would be a byte-identical alias.
    const h = makeRailHarness({ primaryTab: "annotations" });
    h.model.selectRailTab("chat");
    expect(h.model.activeRailTab).toBe("chat");
    expect(h.closeCalls).toEqual([]);
  });

  it("showAnnotations does NOT close a transient chat reveal", () => {
    // The discriminating fact between the two writers, and the only reachable
    // one: `showAnnotations` is the raw write from `onAnnotationClick`, which
    // never called the closer. Collapsing it into `selectRailTab` would add a
    // teardown that site does not perform.
    const h = makeRailHarness({ primaryTab: "chat" });
    h.model.showAnnotations();
    expect(h.model.activeRailTab).toBe("annotations");
    expect(h.closeCalls).toEqual([]);
  });
});

describe("LayoutModel.pendingAnnotationBadge", () => {
  it("is 0 while the Annotations tab is already active", () => {
    const h = makeRailHarness({
      primaryTab: "annotations",
      annotations: [pending("a"), pending("b")],
    });
    expect(h.model.pendingAnnotationBadge).toBe(0);
  });

  it("counts pending review targets while the Chat tab is active", () => {
    const h = makeRailHarness({
      primaryTab: "chat",
      annotations: [pending("a"), pending("b")],
    });
    expect(h.model.pendingAnnotationBadge).toBe(2);
  });

  it("tracks the annotation list in BOTH directions", () => {
    // Both directions, one model instance: a spec that only ever grows the
    // list, or that rebuilds the model between assertions, cannot distinguish
    // a live derivation from one frozen at construction.
    const h = makeRailHarness({ primaryTab: "chat" });
    expect(h.model.pendingAnnotationBadge).toBe(0);
    h.setAnnotations([pending("a"), pending("b"), pending("c")]);
    expect(h.model.pendingAnnotationBadge).toBe(3);
    h.setAnnotations([pending("a")]);
    expect(h.model.pendingAnnotationBadge).toBe(1);
  });

  it("ignores annotations that are not pending review targets", () => {
    const resolved = { ...pending("a"), status: "accepted" } as unknown as Annotation;
    const h = makeRailHarness({ primaryTab: "chat", annotations: [resolved, pending("b")] });
    expect(h.model.pendingAnnotationBadge).toBe(1);
  });

  it("drops to 0 when the user switches to the Annotations tab", () => {
    const h = makeRailHarness({ primaryTab: "chat", annotations: [pending("a")] });
    expect(h.model.pendingAnnotationBadge).toBe(1);
    h.model.selectRailTab("annotations");
    expect(h.model.pendingAnnotationBadge).toBe(0);
  });
});
