import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { RailTab } from "../../src/client/layout/model.svelte.js";
import { createRailContentModel } from "../../src/client/layout/rail-content.svelte.js";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import type { Annotation } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * A BEFORE-measurement for ADR-035 Unit 10c, which moves `activeAnnotationId`
 * out of `App.svelte` behind a getter/setter pair.
 *
 * `useAnnotationReview`'s auto-advance `$effect` reads the active id through
 * `getActiveAnnotationId()` and, when that annotation stops being pending,
 * writes a new one through `onActiveAnnotationChange()` — a read and a write of
 * the same cell inside one effect, which is the shape that usually means a
 * reentrancy hazard.
 *
 * **It is not one here, and that was measured rather than reasoned.** The
 * planning notes for this unit claimed a setter storing a fresh identity
 * (`box = { id: next }` instead of a bare string) would invalidate on every
 * write and die in `effect_update_depth_exceeded`. Built and run, that mutant
 * passes all three specs below unchanged. The effect terminates on its BRANCH
 * STRUCTURE, not on `$state`'s `===` short-circuit: whatever it writes is either
 * `targets[reviewIndex]`, which is pending by construction (`getReviewTargets`
 * filters on it) and so returns at `stillLive`, or `null`, which returns at the
 * guard one line in. There is no value it can write that re-enters the write.
 *
 * So this file pins the auto-advance CONTRACT — writes only on a dead active id,
 * exactly once, to the first remaining target — and does not pin a loop, because
 * there is no loop to pin. Anyone extracting this cell can pick the setter shape
 * on ordinary grounds; a primitive is still the right call, but not because the
 * alternative hangs.
 *
 * **The write branch must actually be entered or this counts zero of zero.** So
 * the fixture drives a live annotation non-pending: `stillLive` goes false, the
 * effect writes, and `writes` is asserted non-empty. A version of this test that
 * only mounted and asserted "no error" would pass with the effect never having
 * reached its write at all.
 *
 * No production change accompanies the first suite. It is the baseline the
 * extraction gets to fail against, not a description of the extraction.
 *
 * The second suite closes the gap that leaves: `activeIdCell` is a hand-built
 * lookalike of what Unit 10c ships, so on its own this file argues by
 * SIMILARITY — it would stay green against a real model whose setter did
 * something else entirely. The integration suite at the bottom drives the same
 * transition through `createRailContentModel` itself.
 */

/** A `$state` cell shaped like the one Unit 10c will expose from its model. */
function activeIdCell(initial: string | null) {
  let activeAnnotationId = $state<string | null>(initial);
  return {
    get value() {
      return activeAnnotationId;
    },
    set(next: string | null) {
      activeAnnotationId = next;
    },
  };
}

describe("useAnnotationReview auto-advance — reentrancy", () => {
  /**
   * Mount the hook with a reactive annotations array and a reactive active-id
   * cell, recording every `onActiveAnnotationChange` the effect performs.
   */
  function mount(initialActive: string | null, initial: Annotation[]) {
    const cell = activeIdCell(initialActive);
    let annotations = $state<Annotation[]>(initial);
    const writes: (string | null)[] = [];

    render(UseAnnotationReviewHarness, {
      props: {
        params: {
          getYdoc: () => null,
          getEditor: () => null,
          getAnnotations: () => annotations,
          getActiveAnnotationId: () => cell.value,
          onActiveAnnotationChange: (id: string | null) => {
            writes.push(id);
            cell.set(id);
          },
          getScrollBehavior: () => "auto" as ScrollBehavior,
        },
        onReady: () => {},
      },
    });
    flushSync();

    return {
      writes,
      active: () => cell.value,
      setAnnotations(next: Annotation[]) {
        annotations = next;
        flushSync();
      },
    };
  }

  const live = makeAnnotation({ id: "a1", author: "claude", status: "pending" });
  const next = makeAnnotation({ id: "a2", author: "claude", status: "pending" });

  it("does not write while the active annotation is still pending", () => {
    const h = mount("a1", [live, next]);
    // The negative half. If the effect wrote unconditionally, the auto-advance
    // below would be indistinguishable from a clobber, and the run count in the
    // next test would be measuring the wrong thing.
    expect(h.writes).toEqual([]);
    expect(h.active()).toBe("a1");
  });

  it("advances exactly once and settles when the active annotation stops being pending", () => {
    const h = mount("a1", [live, next]);

    // Enter the write branch: `stillLive` is false, so the effect advances to
    // the first remaining review target.
    h.setAnnotations([{ ...live, status: "accepted" }, next]);

    // Non-empty is the load-bearing half — it is what makes the count below a
    // measurement of the write path rather than of a branch never taken.
    expect(h.writes.length).toBeGreaterThan(0);
    // And exactly one: the effect re-runs after its own write (it reads the cell
    // it wrote), reads "a2", finds it live, and returns. The count is what a
    // future writer of this cell has to keep at 1 — see the header for why an
    // extra run cannot become an unbounded one.
    expect(h.writes).toEqual(["a2"]);
    expect(h.active()).toBe("a2");
  });

  it("advances to the FIRST remaining target, not just any of them", () => {
    // Three annotations, so first and last differ. Without this the whole file
    // is satisfied by an effect advancing to `targets[targets.length - 1]` --
    // measured: that mutant survived every other spec here, because each of
    // them leaves exactly one target standing and first IS last in a set of one.
    const third = makeAnnotation({ id: "a3", author: "claude", status: "pending" });
    const h = mount("a1", [live, next, third]);
    h.setAnnotations([{ ...live, status: "accepted" }, next, third]);

    expect(h.writes).toEqual(["a2"]);
    expect(h.active()).toBe("a2");
  });

  it("settles on null when no review targets remain", () => {
    const h = mount("a1", [live]);
    h.setAnnotations([{ ...live, status: "dismissed" }]);

    // The empty-target arm of the same branch, and the one that carries the
    // termination argument: `null` returns at the effect's first guard, so a
    // setter that re-invalidates on every write still cannot get a second write
    // out of it.
    expect(h.writes).toEqual([null]);
    expect(h.active()).toBeNull();
  });
});

describe("useAnnotationReview auto-advance — through the real rail-content model", () => {
  const live = makeAnnotation({ id: "a1", author: "claude", status: "pending" });
  const next = makeAnnotation({ id: "a2", author: "claude", status: "pending" });

  let disposeRoot: (() => void) | null = null;
  afterEach(() => {
    disposeRoot?.();
    disposeRoot = null;
  });

  /**
   * The same non-pending transition, with `createRailContentModel` standing
   * where `activeIdCell` stood. Nothing above this line touches the shipped
   * model, so without this the suite pins a stub that happens to resemble it.
   *
   * The model is built inside an `$effect.root` because its three `$effect`s
   * need an owner: `render()` gives the HOOK a component context, not the model.
   */
  function mountIntegrated(initialActive: string | null, initial: Annotation[]) {
    let annotations = $state<Annotation[]>(initial);
    const writes: (string | null)[] = [];
    let model!: ReturnType<typeof createRailContentModel>;

    disposeRoot = $effect.root(() => {
      model = createRailContentModel({
        getActiveRailTab: () => "annotations" as RailTab,
        getEffectiveRightVisible: () => true,
        getFindBarOpen: () => false,
        getEditor: () => null,
        getActiveTabId: () => "doc-1",
        getVisibleAnnotations: () => annotations,
        getFirstReviewTarget: () => annotations.find((a) => a.status === "pending"),
      });
    });
    flushSync();
    model.setActiveAnnotationId(initialActive);
    flushSync();

    render(UseAnnotationReviewHarness, {
      props: {
        params: {
          getYdoc: () => null,
          getEditor: () => null,
          getAnnotations: () => annotations,
          getActiveAnnotationId: () => model.activeAnnotationId,
          onActiveAnnotationChange: (id: string | null) => {
            writes.push(id);
            model.setActiveAnnotationId(id);
          },
          getScrollBehavior: () => "auto" as ScrollBehavior,
        },
        onReady: () => {},
      },
    });
    flushSync();

    return {
      writes,
      active: () => model.activeAnnotationId,
      setAnnotations(next: Annotation[]) {
        annotations = next;
        flushSync();
      },
    };
  }

  it("advances exactly once through the shipped model's setter", () => {
    const h = mountIntegrated("a1", [live, next]);
    expect(h.writes).toEqual([]);

    h.setAnnotations([{ ...live, status: "accepted" }, next]);

    // Same three assertions as the stub suite, so a divergence between the two
    // is attributable to the model rather than to the fixture.
    expect(h.writes).toEqual(["a2"]);
    expect(h.active()).toBe("a2");
  });

  it("settles on null through the shipped model's setter", () => {
    const h = mountIntegrated("a1", [live]);
    h.setAnnotations([{ ...live, status: "dismissed" }]);

    expect(h.writes).toEqual([null]);
    expect(h.active()).toBeNull();
  });
});
