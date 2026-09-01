import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
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
 * No production change accompanies this file. It is the baseline the extraction
 * gets to fail against, not a description of the extraction.
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
