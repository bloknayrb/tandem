/**
 * The DEV untagged-write detector (#1482).
 *
 * The claim being pinned is that this catches what static analysis cannot: a
 * bare `map.set(...)` with no transact around it at all, which `audit-origins`
 * — a textual walk for `.transact(` — is structurally unable to see. The first
 * test is therefore the load-bearing one; the rest exist to show it does not
 * fire on the things it must stay quiet about, because a detector that cries at
 * ordinary typing gets deleted in week two.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { installUntaggedWriteWarning } from "../../src/client/utils/untagged-write-warning";
import { withBrowser } from "../../src/shared/origins";

describe("installUntaggedWriteWarning", () => {
  let doc: Y.Doc;
  let reports: number;
  let stop: () => void;

  beforeEach(() => {
    doc = new Y.Doc();
    reports = 0;
    stop = installUntaggedWriteWarning(doc, { onReport: () => reports++ });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => {
      stop();
      doc.destroy();
      vi.restoreAllMocks();
    };
  });

  it("catches a bare map.set with no transact at all", () => {
    // THE CASE STATIC ANALYSIS CANNOT REACH. Seven of the twelve sites #1482
    // ultimately fixed had this exact shape, and the issue as filed missed
    // them precisely because they contain no `.transact(` to grep for.
    doc.getMap("annotations").set("a", { status: "pending" });
    expect(reports).toBe(1);
  });

  it("catches a raw doc.transact with no origin argument", () => {
    doc.transact(() => doc.getMap("chat").set("m", 1));
    expect(reports).toBe(1);
  });

  it("stays silent for a write tagged through a helper", () => {
    withBrowser(doc, () => doc.getMap("chat").set("m", 1));
    expect(reports).toBe(0);
  });

  it("stays silent for a non-mutating transaction", () => {
    // Yjs opens transactions for read-side bookkeeping. Warning on those would
    // bury the signal, so the handler gates on `changed.size`.
    doc.transact(() => {
      doc.getMap("chat").get("nothing");
    });
    expect(reports).toBe(0);
  });

  it("stays silent for an update applied with an origin, as remote sync does", () => {
    // Hocuspocus applies incoming updates with the `Connection` as origin, so
    // remote edits must not trip this. Verified against a real update rather
    // than asserted, since this is the difference between a useful detector and
    // one that fires on every keystroke from another client.
    const other = new Y.Doc();
    other.getMap("chat").set("remote", true);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), "provider");
    expect(reports).toBe(0);
    other.destroy();
  });

  it("counts each untagged transaction once, not each key", () => {
    doc.transact(() => {
      const map = doc.getMap("chat");
      map.set("a", 1);
      map.set("b", 2);
    });
    expect(reports).toBe(1);
  });

  it("stops reporting after unsubscribe", () => {
    stop();
    doc.getMap("chat").set("a", 1);
    expect(reports).toBe(0);
  });

  it("names the doc when a label was supplied", () => {
    const warn = vi.mocked(console.warn);
    doc.getMap("chat").set("a", 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Untagged Y.Doc write"));
  });
});
