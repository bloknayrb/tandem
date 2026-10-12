/**
 * The launcher gap watch's default subscription (#2181), against the REAL
 * queue. It subscribes `"internal"`, which the queue does not Solo-gate, so
 * the gate is the wrapper's job. These events are the ones that prove it: the
 * privacy hold lets accept/dismiss through in Solo, so a bare internal
 * subscriber would see them, and only the wrapper keeps them out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _pushEventForTests,
  getSubscriberCount,
  resetForTesting,
} from "../../../src/server/events/queue.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import { defaultSubscribeDuringGap } from "../../../src/server/launcher/supervisor.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";

let seq = 0;
function accepted(): TandemEvent {
  seq++;
  return {
    id: `evt_gap_${seq}`,
    type: "annotation:accepted",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { annotationId: `ann_${seq}`, textSnippet: "x" },
  } as unknown as TandemEvent;
}

function chat(): TandemEvent {
  seq++;
  return {
    id: `evt_gap_${seq}`,
    type: "chat:message",
    timestamp: Date.now(),
    payload: { messageId: `m${seq}`, text: "hello" },
  } as TandemEvent;
}

describe("defaultSubscribeDuringGap", () => {
  let seen: TandemEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    resetForTesting();
    seen = [];
    unsubscribe = defaultSubscribeDuringGap((e) => seen.push(e));
  });

  afterEach(() => {
    unsubscribe();
    setCtrlMode("tandem");
  });

  it("passes an annotation event in Tandem mode", () => {
    setCtrlMode("tandem");
    _pushEventForTests(accepted());
    expect(seen.map((e) => e.type)).toEqual(["annotation:accepted"]);
  });

  it("holds an annotation event in Solo, which the queue itself does not hold", () => {
    setCtrlMode("solo");
    _pushEventForTests(accepted());
    expect(seen).toEqual([]);
  });

  it("holds an annotation event when the mode is unknown", () => {
    setCtrlMode(null);
    _pushEventForTests(accepted());
    expect(seen).toEqual([]);
  });

  it("passes chat in Solo, the always-delivered channel", () => {
    setCtrlMode("solo");
    _pushEventForTests(chat());
    expect(seen.map((e) => e.type)).toEqual(["chat:message"]);
  });

  it("does not count as an external subscriber", () => {
    // Nothing outside the process is attached during the gap, and `0` is the
    // sound negative the wake advisory reads.
    expect(getSubscriberCount()).toBe(0);
  });

  it("stops receiving once unsubscribed", () => {
    setCtrlMode("tandem");
    unsubscribe();
    _pushEventForTests(chat());
    expect(seen).toEqual([]);
  });
});
