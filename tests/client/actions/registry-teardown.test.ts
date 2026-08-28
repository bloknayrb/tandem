// @vitest-environment happy-dom

/**
 * Teardown coverage for the action registry (Unit 9).
 *
 * The property that is easy to get wrong and impossible to see from a passing
 * `getActionsMap()` read: **the copy-and-reassign is the notification.**
 * `actionsMap` is `$state(new Map(...))`, and Svelte 5 does not proxy a `Map` —
 * `.set`/`.delete` are invisible to the reactive graph. Every consumer
 * (CommandPalette, HelpModal, ShortcutEditorList) reads by iterating inside a
 * `$derived.by`, so a mutating delete would leave all of them showing a removed
 * action until an unrelated `registerAction` happened to reassign.
 *
 * A test that merely asserted `getActionsMap().has(id) === false` would pass
 * against that bug — the mutated Map reads correctly, it just never told anyone.
 * So the reassignment specs observe through a `$derived`, via `$effect.root`,
 * which is the only thing that can tell the two apart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Action,
  getActionsMap,
  registerAction,
  registerActions,
  unregisterAction,
} from "../../../src/client/actions/registry.svelte.js";
import { observeRegistry } from "../../helpers/registry-observer.svelte.js";

const reportErrorSpy = vi.fn();
vi.mock("../../../src/client/sentry.js", () => ({
  reportError: (...args: unknown[]) => reportErrorSpy(...args),
}));

let n = 0;
const uniqueId = () => `unit9-test-${++n}`;

function makeAction(id: string, label = "Test action"): Action {
  return { id, label, group: "document", run: () => {} };
}

const planted: string[] = [];
function plant(action: Action): Action {
  planted.push(action.id);
  return action;
}

afterEach(() => {
  for (const id of planted.splice(0)) unregisterAction(id);
  reportErrorSpy.mockClear();
  vi.restoreAllMocks();
});

describe("unregisterAction", () => {
  it("removes the action AND notifies derived consumers", () => {
    const id = uniqueId();
    registerAction(plant(makeAction(id)));

    const watcher = observeRegistry(id);
    expect(watcher.present()).toBe(true);

    expect(unregisterAction(id)).toBe(true);

    // The half a mutating `.delete()` would fail: the derived must re-run.
    expect(watcher.present()).toBe(false);
    watcher.stop();
  });

  it("returns false and leaves the cell alone for an unknown id", () => {
    expect(unregisterAction("no-such-action-id")).toBe(false);
  });
});

describe("registerActions", () => {
  it("registers a batch and notifies consumers", () => {
    const id = uniqueId();
    const reg = registerActions([plant(makeAction(id))]);

    const watcher = observeRegistry(id);
    expect(watcher.present()).toBe(true);

    reg.dispose();
    expect(watcher.present()).toBe(false);
    watcher.stop();
  });

  it("removes exactly its own ids and leaves everything else standing", () => {
    const mine = uniqueId();
    const theirs = uniqueId();
    registerAction(plant(makeAction(theirs)));
    const reg = registerActions([plant(makeAction(mine))]);

    reg.dispose();

    expect(getActionsMap().has(mine)).toBe(false);
    expect(getActionsMap().has(theirs)).toBe(true);
  });

  it("warns and leaves a superseded entry alone rather than deleting someone else's", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = uniqueId();
    const reg = registerActions([plant(makeAction(id, "original"))]);

    const replacement = makeAction(id, "replacement");
    registerAction(replacement, { replace: true });

    reg.dispose();

    expect(getActionsMap().get(id)).toBe(replacement);
    expect(warn.mock.calls.flat().join(" ")).toContain(id);
    // Reported, not merely logged: two owners are fighting over one id and the
    // loser's teardown is now permanently incomplete. A console line in a
    // shipped desktop build (devtools excluded) reaches nobody.
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "actionRegistry", actionId: id }),
    );
  });

  it("rejects a duplicate id WITHIN one batch even with { replace: true }", () => {
    // `replace` says "this batch owns ids that already exist" — a legitimate
    // claim on an HMR re-run. It says nothing about an array that names the same
    // id twice, which is always an authoring bug: the later entry wins, the
    // disposer's identity check then declines to remove the earlier one, and the
    // batch is silently one action shorter than it reads.
    const dup = uniqueId();
    expect(() =>
      registerActions([makeAction(dup, "first"), makeAction(dup, "second")], { replace: true }),
    ).toThrow(/collision/);
    expect(getActionsMap().has(dup)).toBe(false);
  });

  it("re-registers an existing batch without throwing when { replace: true }", () => {
    // The shipped shape: `builtin.svelte.ts` re-runs its module body on an HMR
    // edit, against a registry that still holds the previous copies. There is no
    // disposer to call first (vite never looks one up for a `.svelte.ts`), so
    // declaring the replacement is what keeps DEV from throwing on every edit.
    const id = uniqueId();
    const first = plant(makeAction(id, "first"));
    registerActions([first]);

    const second = makeAction(id, "second");
    expect(() => registerActions([second], { replace: true })).not.toThrow();
    expect(getActionsMap().get(id)).toBe(second);
  });

  it("pre-validates the whole batch, so a collision leaves the registry untouched", () => {
    // A mid-batch throw would otherwise half-populate the registry and never
    // return a disposer — the unrecoverable state the batch API exists to avoid.
    const existing = uniqueId();
    const fresh = uniqueId();
    registerAction(plant(makeAction(existing)));

    const before = new Map(getActionsMap());
    expect(() => registerActions([makeAction(fresh), makeAction(existing)])).toThrow(/collision/);

    expect(getActionsMap().has(fresh)).toBe(false);
    expect(getActionsMap().size).toBe(before.size);
  });

  it("has an idempotent disposer that cannot delete a later batch's entries", () => {
    // `BUILTINS` is a module-level const array, so register → dispose →
    // register hands the SAME object references back. Without idempotence a
    // stale disposer called twice would delete the live batch's entries.
    const id = uniqueId();
    const action = plant(makeAction(id));

    const first = registerActions([action]);
    first.dispose();
    const second = registerActions([action]);

    first.dispose(); // stale, must be a no-op

    expect(getActionsMap().get(id)).toBe(action);
    second.dispose();
    expect(getActionsMap().has(id)).toBe(false);
  });

  it("lets a batch be re-registered after teardown without a DEV collision throw", () => {
    const id = uniqueId();
    const action = plant(makeAction(id));
    const first = registerActions([action]);
    first.dispose();

    // The HMR shape: module body re-runs against a registry the previous
    // instance already tore down. Before the disposer existed, this threw.
    expect(() => registerActions([action]).dispose()).not.toThrow();
  });
});
