// @vitest-environment happy-dom

/**
 * The dark guarantee of the chat-answerer store (#1123 part B, R1.6): with
 * `BYO_MODELS_ENABLED` off (forced by this file's mock), no trigger fetches,
 * nothing is recorded and the switch is never sent. The one guard is
 * `requestRead`'s (and the setter's) first line; removing it turns this red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetChatAnswererForTests,
  createCardSendNotice,
  createChatAnswerer,
  inLocalPeriod,
  noteChatSent,
  noteCtrlSynced,
  noteHeld,
  noteNoticeRowArrived,
  noteNotifyNotice,
  observeChatForAnswerer,
  pressUseItForChat,
  requestRead,
  setChatAnswerer,
  setChatAnswererToastSink,
  takeSendRead,
} from "../../src/client/hooks/useChatAnswerer.svelte";
import { signalModelsWriteCommitted } from "../../src/client/models/models-write-signal";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import type { ChatMessage, TandemNotification } from "../../src/shared/types";
import { drain } from "../helpers/held-fetch";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

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
  it("the anchor: the file-level mock applied, so the flag reads false here", () => {
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
    expect(await setChatAnswerer("local")).toEqual({ kind: "not-sent" });
    await drain();
    expect(fetchSpy).not.toHaveBeenCalled();
    const state = createChatAnswerer();
    expect(state.status).toBe("pending");
    expect(state.sentLocal.size).toBe(0);
    expect(inLocalPeriod(true)).toBe(false);
  });

  it("'Use it for chat': a first local model and a press push, dismiss and fetch nothing", async () => {
    // A sink set by hand (App sets none while dark). Without the press's own
    // flag line, its read answers "dark", the store is not known, and it
    // pushes X: so this is red if that line is removed.
    const sink = { push: vi.fn(), dismiss: vi.fn(), dismissActivity: vi.fn() };
    setChatAnswererToastSink(sink);
    signalModelsWriteCommitted({ firstLocal: true });
    await drain();
    await pressUseItForChat();
    await drain();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sink.push).not.toHaveBeenCalled();
    expect(sink.dismiss).not.toHaveBeenCalled();
    expect(sink.dismissActivity).not.toHaveBeenCalled();
  });

  it("a chat send records no read, so the send-time toast never waits (#2433 M1, R1.4)", () => {
    // `requestRead`'s own guard alone keeps fetch silent, so "no fetch" cannot
    // fail if `noteChatSent`'s guard is dropped; the take's result can: it
    // would be a handle on a resolved `{ status: "dark" }` read.
    const msg = { id: "u2", author: "user", text: "q", timestamp: 2, read: false } as ChatMessage;
    noteChatSent(msg, { aiOff: false, held: false });
    expect(takeSendRead()).toBeNull();
    noteChatSent(msg, { aiOff: false, held: true });
    expect(takeSendRead()).toBeNull();
  });

  // The send notice (#1123, R5): dark, a card send's decision shows nothing
  // and fetches nothing. The guard is `inLocalPeriod`'s first line (App never
  // fills the seam while dark either; the wiring pin holds that half).
  it("the send notice, held true, tandem, reachable: no toast, no fetch", async () => {
    const push = vi.fn<(n: TandemNotification) => void>();
    const raise = createCardSendNotice({
      getHeld: () => true,
      getMode: () => "tandem",
      getServerUnreachable: () => false,
      push,
    });
    raise();
    await drain();
    expect(push).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the send notice, held true, tandem, unreachable: no toast, no fetch (row 2)", async () => {
    const push = vi.fn<(n: TandemNotification) => void>();
    const raise = createCardSendNotice({
      getHeld: () => true,
      getMode: () => "tandem",
      getServerUnreachable: () => true,
      push,
    });
    raise();
    await drain();
    expect(push).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
