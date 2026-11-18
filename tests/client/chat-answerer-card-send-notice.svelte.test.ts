// @vitest-environment happy-dom

/**
 * The send notice's decision (#1123, the brief "the send notice", R3):
 * `createCardSendNotice` in `hooks/useChatAnswerer.svelte.ts`, with the REAL
 * store, reads planted through `fetch` held open and answered by hand
 * (`installHeldFetch`, as `chat-answerer-store.svelte.test.ts`), and a spy for
 * `push`.
 *
 * `BYO_MODELS_ENABLED` is flipped on by mocking the constant; the dark cases
 * are in `chat-answerer-store-dark.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemMode, TandemNotification } from "../../src/shared/types";
import { installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const store = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
const { setCardSendRaise } = await import("../../src/client/panels/card-send-raise.js");

asTandemOwnWindow();

// W: the reviewing session's ruling R2.1 on Bryan's pick SN-P2, "Say it waits
// for Claude (Recommended)". Quoted from the brief, not from the code.
const W = "Saved. Chat is set to your local model, so this comment waits for Claude.";
const NOW = new Date("2026-11-18T12:00:00Z").getTime();
// The id and dedupKey: Ruling SN-4, the composer's shape `${idPrefix}-${viaKey}`
// with idPrefix `ai-local-comment` and viaKey `comment` (App's addressed-ai
// handler); severity info, type launcher, no CTA (R3.1, "The toast").
const W_TOAST: TandemNotification = {
  id: `ai-local-comment-comment-${NOW}`,
  type: "launcher",
  severity: "info",
  message: W,
  dedupKey: "ai-local-comment-comment",
  timestamp: NOW,
};

let held: ReturnType<typeof installHeldFetch>;

beforeEach(() => {
  store._resetChatAnswererForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  held = installHeldFetch();
});

afterEach(() => {
  setCardSendRaise(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const known = (answerer: "claude" | "local") => ({
  answerer,
  localModelResolves: false,
  localModelState: "none",
  runGeneration: "gen-1",
});

/** Plant a known read through the real store. */
async function plant(answerer: "claude" | "local"): Promise<void> {
  const p = store.requestRead();
  const call = await held.request(held.calls.length + 1);
  await call.answer(200, known(answerer));
  await p;
  expect(store.createChatAnswerer().status).toBe("known");
  // `vi.waitFor` advances the faked clock while it polls; put it back.
  vi.setSystemTime(NOW);
}

type Read = "known local" | "known claude" | "not known";

function harness(init: { held: boolean; mode: TandemMode; unreachable: boolean }) {
  const s = { ...init };
  const push = vi.fn<(n: TandemNotification) => void>();
  const raise = store.createCardSendNotice({
    getHeld: () => s.held,
    getMode: () => s.mode,
    getServerUnreachable: () => s.unreachable,
    push,
  });
  return { s, push, raise };
}

describe("the anchor", () => {
  it("the file-level mock applied, so the flag reads true here", async () => {
    const { BYO_MODELS_ENABLED } = await import("../../src/shared/constants.js");
    expect(BYO_MODELS_ENABLED).toBe(true);
  });
});

describe("the precedence table, first match wins (R3.1)", () => {
  const ROWS: Array<
    [Read, boolean, TandemMode, boolean, "none" | "W", string /* row and its source */]
  > = [
    // Row 1, Solo: the reviewing session's precedence ruling (R3.1).
    ["known local", true, "solo", false, "none", "1"],
    // Row 2, unreachable is silence: R3.1's "Why row 2 is silence".
    ["known local", false, "tandem", true, "none", "2"],
    ["not known", true, "tandem", true, "none", "2 (factory-only state)"],
    // Rows 3 and 4: Ruling B-16, a known read always wins; held counts only
    // when the read is not known.
    ["known local", false, "tandem", false, "W", "3"],
    ["not known", true, "tandem", false, "W", "3"],
    ["known claude", true, "tandem", false, "none", "4"],
    ["not known", false, "tandem", false, "none", "4"],
  ];

  for (const [read, heldFlag, mode, unreachable, expected, row] of ROWS) {
    it(`${read}, held ${heldFlag}, ${mode}, unreachable ${unreachable}: ${expected} (row ${row})`, async () => {
      if (read === "known local") await plant("local");
      if (read === "known claude") await plant("claude");
      const { push, raise } = harness({ held: heldFlag, mode, unreachable });
      raise();
      if (expected === "W") {
        expect(push).toHaveBeenCalledTimes(1);
        expect(push.mock.calls[0]).toEqual([W_TOAST]);
        expect(push).toHaveBeenCalledWith(W_TOAST);
      } else {
        expect(push).not.toHaveBeenCalled();
      }
    });
  }
});

describe("creation and live reads (R3.1)", () => {
  it("creation reads no getter: every getter throwing, creation does not throw", () => {
    const boom = () => {
      throw new ReferenceError("read at creation");
    };
    const push = vi.fn();
    expect(() =>
      store.createCardSendNotice({
        getHeld: boom,
        getMode: boom,
        getServerUnreachable: boom,
        push,
      }),
    ).not.toThrow();
    expect(push).not.toHaveBeenCalled();
  });

  it("one instance follows each getter's current value (nothing cached)", () => {
    const { s, push, raise } = harness({ held: false, mode: "tandem", unreachable: false });
    raise(); // 1. not known, held false: none
    expect(push).toHaveBeenCalledTimes(0);
    s.held = true;
    raise(); // 2. held true: W
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenLastCalledWith(W_TOAST);
    s.mode = "solo";
    raise(); // 3. Solo: none
    expect(push).toHaveBeenCalledTimes(1);
    s.mode = "tandem";
    s.unreachable = true;
    raise(); // 4. unreachable: none
    expect(push).toHaveBeenCalledTimes(1);
    s.unreachable = false;
    raise(); // 5. reachable again: W
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith(W_TOAST);
  });
});

describe("the send dispatches and fetches nothing (R3.2)", () => {
  it("around real raises, no fetch and no tandem:addressed-ai", async () => {
    await plant("local");
    const fetchesBefore = held.calls.length;
    let dispatched = 0;
    const onAddressed = () => {
      dispatched++;
    };
    window.addEventListener("tandem:addressed-ai", onAddressed);
    try {
      const { s, push, raise } = harness({ held: false, mode: "tandem", unreachable: false });
      raise();
      s.held = true;
      raise();
      s.unreachable = true;
      raise();
      await Promise.resolve();
      expect(push).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("tandem:addressed-ai", onAddressed);
    }
    expect(held.calls.length).toBe(fetchesBefore);
    expect(dispatched).toBe(0);
  });

  it("through the seam: a filled raise pushes once per card send", async () => {
    // The end-to-end shape App builds: the seam filled with the decision.
    await plant("local");
    const { push, raise } = harness({ held: false, mode: "tandem", unreachable: false });
    setCardSendRaise(raise);
    const { raiseCardSend } = await import("../../src/client/panels/card-send-raise.js");
    raiseCardSend();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(W_TOAST);
  });
});
