/**
 * Tests for the per-key Y.Map change observer factory (ADR-035 part 1/N).
 *
 * The factory's load-bearing contract is the `derive` callback's payload —
 * specifically that delete actions carry the pre-delete `oldValue` so
 * downstream consumers (the annotation lifecycle PR being the immediate
 * consumer) can record tombstones from values that no longer exist in
 * the Y.Map after the change.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { makePerKeyChangeObserver } from "../../../src/server/events/observers/factory.js";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "../../../src/shared/origins.js";

// biome-ignore lint/suspicious/noExplicitAny: Y.Doc.transact's second arg is `unknown`.
const rawTransact = (doc: Y.Doc, fn: () => void, origin?: unknown) =>
  (doc as any).transact(fn, origin);

interface SamplePayload {
  id: string;
  rev: number;
  text: string;
}

describe("makePerKeyChangeObserver — delete-path contract", () => {
  it("delivers action=delete with the pre-delete oldValue (load-bearing for tombstones)", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("samples");
    const derive = vi.fn();

    // Seed an entry — register the observer afterwards so the seed write
    // doesn't appear in the captured calls. Only the subsequent delete matters.
    rawTransact(doc, () =>
      map.set("k1", { id: "k1", rev: 7, text: "alpha" } satisfies SamplePayload),
    );

    const teardown = makePerKeyChangeObserver<SamplePayload>({
      map,
      derive,
      pushEvent: () => {
        /* no-op for this contract test */
      },
    });

    rawTransact(doc, () => map.delete("k1"));

    expect(derive).toHaveBeenCalledTimes(1);
    const ctx = derive.mock.calls[0]?.[0] as {
      action: string;
      value: SamplePayload | undefined;
      oldValue: SamplePayload | undefined;
      key: string;
    };
    expect(ctx.action).toBe("delete");
    expect(ctx.key).toBe("k1");
    expect(ctx.value).toBeUndefined();
    expect(ctx.oldValue).toEqual({ id: "k1", rev: 7, text: "alpha" });

    teardown();
  });

  it("skips baseline channel-skip origins (MCP_ORIGIN, FILE_SYNC_ORIGIN)", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("samples");
    const derive = vi.fn();

    const teardown = makePerKeyChangeObserver<SamplePayload>({
      map,
      derive,
      pushEvent: () => {},
    });

    rawTransact(
      doc,
      () => map.set("k", { id: "k", rev: 1, text: "x" } satisfies SamplePayload),
      MCP_ORIGIN,
    );
    expect(derive).not.toHaveBeenCalled();

    rawTransact(
      doc,
      () => map.set("k2", { id: "k2", rev: 1, text: "y" } satisfies SamplePayload),
      FILE_SYNC_ORIGIN,
    );
    expect(derive).not.toHaveBeenCalled();

    teardown();
  });

  it("composes shouldSkip with the channel-skip set (OR semantics)", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("samples");
    const derive = vi.fn();

    const teardown = makePerKeyChangeObserver<SamplePayload>({
      map,
      derive,
      pushEvent: () => {},
      shouldSkip: (origin) => origin === "ad-hoc-skip",
    });

    // Baseline channel-skip set already blocks MCP — derive not called.
    rawTransact(
      doc,
      () => map.set("k1", { id: "k1", rev: 1, text: "a" } satisfies SamplePayload),
      MCP_ORIGIN,
    );
    expect(derive).not.toHaveBeenCalled();

    // shouldSkip blocks the ad-hoc origin.
    rawTransact(
      doc,
      () => map.set("k2", { id: "k2", rev: 1, text: "b" } satisfies SamplePayload),
      "ad-hoc-skip",
    );
    expect(derive).not.toHaveBeenCalled();

    // Untagged origin (browser) is not skipped by either — derive fires.
    rawTransact(doc, () => map.set("k3", { id: "k3", rev: 1, text: "c" } satisfies SamplePayload));
    expect(derive).toHaveBeenCalledTimes(1);

    teardown();
  });
});
