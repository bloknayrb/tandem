// @vitest-environment happy-dom

/**
 * The dark guarantee of the chat-answerer store (#1123 part B, R1.6): with
 * `BYO_MODELS_ENABLED` at its shipped value (`false`), no trigger fetches,
 * nothing is recorded and the switch is never sent. The one guard is
 * `requestRead`'s (and the setter's) first line; removing it turns this red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetChatAnswererForTests,
  createChatAnswerer,
  inLocalPeriod,
  noteChatSent,
  noteCtrlSynced,
  noteHeld,
  noteNoticeRowArrived,
  noteNotifyNotice,
  observeChatForAnswerer,
  requestRead,
  setChatAnswerer,
} from "../../src/client/hooks/useChatAnswerer.svelte";
import { signalModelsWriteCommitted } from "../../src/client/models/models-write-signal";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";
import { drain } from "../helpers/held-fetch";

const fetchSpy = vi.fn();

beforeEach(() => {
  _resetChatAnswererForTests();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat-answerer store, flag off", () => {
  it("the flag is the shipped literal false", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  it("no trigger fetches, nothing is recorded, nothing is sent", async () => {
    const msg = { id: "u1", author: "user", text: "q", timestamp: 1, read: false } as ChatMessage;
    expect(await requestRead()).toEqual({ status: "dark" });
    noteCtrlSynced({});
    noteCtrlSynced({});
    noteNotifyNotice("local-model-answerer-local");
    noteNoticeRowArrived();
    noteHeld(false);
    noteHeld(true);
    observeChatForAnswerer({ doc: {}, synced: true, messages: [msg] });
    observeChatForAnswerer({
      doc: {},
      synced: true,
      messages: [{ ...msg, localRun: { status: "running", generation: "g" } }],
    });
    noteChatSent(msg, { aiOff: false, held: true });
    signalModelsWriteCommitted({ firstLocal: true });
    await setChatAnswerer("local");
    await drain();
    expect(fetchSpy).not.toHaveBeenCalled();
    const state = createChatAnswerer();
    expect(state.status).toBe("pending");
    expect(state.sentLocal.size).toBe(0);
    expect(inLocalPeriod(true)).toBe(false);
  });
});
