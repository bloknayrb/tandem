/**
 * The pickup row while local models are dark (#1123 part B, R10.1), moved out
 * of `chat-pickup.test.ts` so that file holds in either state of the flag. The
 * guard pinned: `chat-pickup.ts`'s `BYO_MODELS_ENABLED` test that reads the
 * local inputs, `localRun` and `chatNotice` only when lit.
 */
import { describe, expect, it, vi } from "vitest";
import { chatPickup } from "../../src/client/panels/chat-pickup";
import type { ChatMessage } from "../../src/shared/types";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

const T0 = 1_800_000_000_000;

function user(id: string, at: number, read = false): ChatMessage {
  return { id, author: "user", text: id, timestamp: T0 + at, read };
}

function claude(id: string, at: number): ChatMessage {
  return { id, author: "claude", text: id, timestamp: T0 + at, read: true };
}

describe("dark (#1123 part B, R10.1)", () => {
  it("with the flag off, local inputs and rows carrying localRun or chatNotice change nothing", () => {
    const m: ChatMessage = {
      ...user("a", 0),
      localRun: { status: "stopped", reason: "error", generation: "g" },
    };
    const inputs = {
      runGeneration: "g",
      sentLocal: new Set(["a"]),
      readKnownLocal: true,
      aiOff: false,
    };
    expect(chatPickup([m], T0 + 5_000, inputs)).toEqual({ kind: "waiting", waitedMs: 5_000 });
    // A notice row is an untagged-looking Claude row as on master: the row ends.
    const line: ChatMessage = { ...claude("n", 1), chatNotice: "claude-again" };
    expect(chatPickup([user("b", 0), line], T0 + 5_000, inputs)).toBeNull();
  });
});
