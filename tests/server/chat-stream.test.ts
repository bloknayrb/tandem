/**
 * #1340 — ctrl-room chat streaming primitives.
 *
 * The write-volume assertions are BYTE-shaped, never wall-clock: update-payload
 * bytes counted via `doc.on("update")` are deterministic on a loaded or idle
 * machine (this box runs many concurrent suites). They pin the mechanism the
 * fix installs — O(delta) diff-splices into the `chatStream` sidecar `Y.Text` —
 * against the old whole-value re-`set`, which cost O(L²) bytes for a stream of
 * final length L.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendClaudeChatMessage,
  finalizeClaudeChatMessage,
  updateClaudeChatMessage,
} from "../../src/server/mcp/awareness.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_CHAT, Y_MAP_CHAT_STREAM } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";

const FLUSH_STEP = 80; // mirrors STREAM_FLUSH_CHARS in collaborator.ts

function ctrl() {
  return getOrCreateDocument(CTRL_ROOM);
}
function chatMap() {
  return ctrl().getMap(Y_MAP_CHAT);
}
function streamMap() {
  return ctrl().getMap(Y_MAP_CHAT_STREAM);
}
function streamText(id: string): string | null {
  const entry = streamMap().get(id);
  return entry instanceof Y.Text ? entry.toString() : null;
}

/** Drive the real primitives end to end and count ctrl-doc update bytes. */
function measureStreamBytes(finalLength: number, docId: string): number {
  const doc = ctrl();
  let bytes = 0;
  const onUpdate = (update: Uint8Array) => {
    bytes += update.byteLength;
  };
  doc.on("update", onUpdate);
  try {
    const full = "x".repeat(finalLength);
    const id = appendClaudeChatMessage(full.slice(0, FLUSH_STEP), { documentId: docId });
    for (let n = FLUSH_STEP * 2; n < finalLength; n += FLUSH_STEP) {
      updateClaudeChatMessage(id, full.slice(0, n));
    }
    updateClaudeChatMessage(id, full);
    finalizeClaudeChatMessage(id);
  } finally {
    doc.off("update", onUpdate);
  }
  return bytes;
}

beforeEach(() => {
  const doc = ctrl();
  withInternal(doc, () => {
    doc.getMap(Y_MAP_CHAT).clear();
    doc.getMap(Y_MAP_CHAT_STREAM).clear();
  });
});

describe("streamed chat write volume is linear (#1340)", () => {
  it("a full streamed lifecycle costs O(L) update bytes, not O(L²)", () => {
    const L = 16_384;
    const bytes = measureStreamBytes(L, "doc-linearity");
    // Master (whole-value re-set per flush) measures ~104×L (~1.7 MB) here;
    // the sidecar fix measures ~2.3×L (~37 KB). 12×L gives 5× headroom against
    // encoding drift while sitting 8× below the quadratic. RED on master.
    expect(bytes).toBeGreaterThan(L); // sanity: the content did get transmitted
    expect(bytes).toBeLessThanOrEqual(12 * L);
  });

  it("doubling the stream length ~doubles the bytes (pins the curve, not a point)", () => {
    const L = 16_384;
    const b1 = measureStreamBytes(L, "doc-curve-1");
    const b2 = measureStreamBytes(2 * L, "doc-curve-2");
    // Linear ⇒ ratio ≈ 2; quadratic ⇒ ratio ≈ 4. 3 separates them and catches
    // a half-revert that reintroduces any per-flush whole-value chatMap.set.
    expect(b2 / b1).toBeLessThanOrEqual(3);
  });
});

describe("streaming semantics — sidecar authority and fold", () => {
  it("mid-stream: the chat row is deliberately stale; the sidecar holds the full text", () => {
    const id = appendClaudeChatMessage("first flush", { documentId: "d1" });
    updateClaudeChatMessage(id, "first flush and more");
    // The row is untouched between append and finalize — the sidecar is
    // authoritative while it exists (readers compose).
    expect((chatMap().get(id) as ChatMessage).text).toBe("first flush");
    expect(streamText(id)).toBe("first flush and more");
  });

  it("finalize folds the full text into the row, preserves every field verbatim, deletes the sidecar, and is idempotent", () => {
    const id = appendClaudeChatMessage("partial", {
      documentId: "d2",
      replyTo: "u9",
      agentIdentity: { provider: "local-ollama", displayName: "Qwen 2.5" },
    });
    const before = chatMap().get(id) as ChatMessage;
    updateClaudeChatMessage(id, "partial + more");
    updateClaudeChatMessage(id, "partial + more + done");
    finalizeClaudeChatMessage(id);

    const after = chatMap().get(id) as ChatMessage;
    expect(after.text).toBe("partial + more + done");
    expect(after.id).toBe(before.id);
    expect(after.author).toBe("claude");
    expect(after.timestamp).toBe(before.timestamp); // NOT re-stamped (sort stability)
    expect(after.read).toBe(before.read);
    expect(after.documentId).toBe("d2");
    expect(after.replyTo).toBe("u9");
    expect(after.agentIdentity).toEqual({ provider: "local-ollama", displayName: "Qwen 2.5" });
    expect(streamMap().has(id)).toBe(false);

    expect(() => finalizeClaudeChatMessage(id)).not.toThrow(); // idempotent
    expect((chatMap().get(id) as ChatMessage).text).toBe("partial + more + done");
  });

  it("turn-reset replace: a shorter, different text replaces the streamed preamble exactly", () => {
    const id = appendClaudeChatMessage("Let me look at the document. ", { documentId: "d3" });
    updateClaudeChatMessage(id, "Let me look at the document. It seems that");
    // onTurnEnd({hadToolCalls:true}) resets the buffer; the next turn streams a
    // different, shorter answer — common prefix 0 → delete-all + insert.
    updateClaudeChatMessage(id, "Done.");
    expect(streamText(id)).toBe("Done.");
    finalizeClaudeChatMessage(id);
    expect((chatMap().get(id) as ChatMessage).text).toBe("Done.");
  });

  it("truncation-marker append: extending the last flushed buffer is committed exactly", () => {
    const body = "y".repeat(200);
    const marker = "\n\n_[Reply truncated — the model exceeded the streaming limit.]_";
    const id = appendClaudeChatMessage(body.slice(0, 80), { documentId: "d4" });
    updateClaudeChatMessage(id, body);
    updateClaudeChatMessage(id, body + marker); // pure extension, like the #1292 cap path
    finalizeClaudeChatMessage(id);
    expect((chatMap().get(id) as ChatMessage).text).toBe(body + marker);
  });

  it("equal text is a no-op that broadcasts nothing", () => {
    const id = appendClaudeChatMessage("stable", { documentId: "d5" });
    updateClaudeChatMessage(id, "stable text so far");
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
    };
    ctrl().on("update", onUpdate);
    try {
      updateClaudeChatMessage(id, "stable text so far");
    } finally {
      ctrl().off("update", onUpdate);
    }
    expect(updates).toBe(0);
    expect(streamText(id)).toBe("stable text so far");
  });

  it("empty text never mints a sidecar entry that would shadow the row (pins the equal-text guard)", () => {
    // The load-bearing case for `if (current === text) return`. Without it a
    // flush of "" before any sidecar exists mints an EMPTY Y.Text, which is
    // AUTHORITATIVE over the row — every reader then composes an empty bubble
    // for a message that has text.
    const id = appendClaudeChatMessage("a real answer", { documentId: "d10" });
    updateClaudeChatMessage(id, "");
    expect(streamMap().has(id)).toBe(false);
    expect((chatMap().get(id) as ChatMessage).text).toBe("a real answer");
  });

  it("finalize drops an EMPTY sidecar Y.Text instead of blanking the row", () => {
    // Malformed state from some other build (today's update path returns
    // before minting one). Folding it would destroy the row's real text.
    const id = appendClaudeChatMessage("a real answer", { documentId: "d11" });
    withInternal(ctrl(), () => streamMap().set(id, new Y.Text()));
    finalizeClaudeChatMessage(id);
    expect((chatMap().get(id) as ChatMessage).text).toBe("a real answer");
    expect(streamMap().has(id)).toBe(false);
  });

  it("update on an unknown id is a no-op that creates no sidecar entry", () => {
    updateClaudeChatMessage("never-appended", "x");
    expect(chatMap().has("never-appended")).toBe(false);
    expect(streamMap().has("never-appended")).toBe(false);
  });

  it("a flush racing a chat clear deletes the orphan sidecar entry and never resurrects the row", () => {
    const id = appendClaudeChatMessage("will be erased", { documentId: "d6" });
    updateClaudeChatMessage(id, "will be erased plus streamed tail");
    // The chat row goes away mid-stream (the clear's live deletion), but a
    // sidecar entry survived — e.g. a flush recreated it between the clear's
    // snapshot capture and its live-doc deletion pass.
    withInternal(ctrl(), () => chatMap().delete(id));
    expect(streamMap().has(id)).toBe(true);
    // The next in-flight flush lands after the clear: it must not recreate
    // anything, and must delete the orphan sidecar entry so the erased
    // message cannot be resurrected by any later fold.
    updateClaudeChatMessage(id, "will be erased plus streamed tail plus more");
    expect(chatMap().has(id)).toBe(false);
    expect(streamMap().has(id)).toBe(false);
  });

  it("finalize after the chat row was deleted mid-stream drops the sidecar without resurrecting the row", () => {
    const id = appendClaudeChatMessage("erase me", { documentId: "d7" });
    updateClaudeChatMessage(id, "erase me and my stream");
    withInternal(ctrl(), () => chatMap().delete(id)); // row gone, sidecar still live
    expect(streamMap().has(id)).toBe(true);
    finalizeClaudeChatMessage(id);
    expect(chatMap().has(id)).toBe(false); // the erased message stays erased
    expect(streamMap().has(id)).toBe(false);
  });
});

describe("surrogate-pair safety (BLOCKER — Yjs substitutes U+FFFD on a mid-pair split)", () => {
  it("a replace whose common prefix ends inside a surrogate pair never corrupts the text", () => {
    // 🙂 (U+1F642, UTF-16 <D83D DE42>) and 🙃 (U+1F643, <D83D DE43>)
    // share the high surrogate 0xD83D, so the naive UTF-16 common prefix is 1
    // — a splice at offset 1 makes Yjs's ContentString.splice write U+FFFD on
    // BOTH sides of the split,
    // permanently, and insert a lone low surrogate. The clamp must back the
    // prefix off to the code-point boundary (p=0 here).
    const id = appendClaudeChatMessage("🙂", { documentId: "d8" });
    updateClaudeChatMessage(id, "🙂x"); // seed the sidecar with the astral text
    expect(streamText(id)).toBe("🙂x");
    updateClaudeChatMessage(id, "🙃y");
    expect(streamText(id)).toBe("🙃y");
    expect(streamText(id)).not.toContain("�");
    finalizeClaudeChatMessage(id);
    const row = chatMap().get(id) as ChatMessage;
    expect(row.text).toBe("🙃y");
    expect(row.text).not.toContain("�");
  });

  it("a RUN of consecutive unpaired high surrogates backs the split all the way off", () => {
    // Yjs substitutes U+FFFD whenever the character before a ContentString
    // split is a high surrogate — paired or not. So backing the prefix off by
    // exactly ONE unit is not enough: here the prefix is 2, one step lands it
    // on another lone high surrogate, and the splice yields "\uFFFD\uD83Dx".
    // The clamp must LOOP until the split point is off high surrogates.
    const id = appendClaudeChatMessage("seed", { documentId: "d12" });
    updateClaudeChatMessage(id, "\uD83D🙃"); // lone high surrogate, then a real pair
    expect(streamText(id)).toBe("\uD83D🙃");
    updateClaudeChatMessage(id, "\uD83D\uD83Dx"); // common prefix 2, both units high
    expect(streamText(id)).toBe("\uD83D\uD83Dx");
    expect(streamText(id)).not.toContain("\uFFFD");
    finalizeClaudeChatMessage(id);
    expect((chatMap().get(id) as ChatMessage).text).toBe("\uD83D\uD83Dx");
  });

  it("the turn-reset shape from the collaborator (emoji preamble → different emoji answer) round-trips exactly", () => {
    const id = appendClaudeChatMessage("🙂 checking", { documentId: "d9" });
    updateClaudeChatMessage(id, "🙂 checking the doc"); // populate the sidecar
    updateClaudeChatMessage(id, "🙃 done"); // shrink+replace across a shared high surrogate
    // Asserted BEFORE any further update: a later replace whose common prefix
    // is 0 would silently repair the corruption and mask a missing clamp.
    expect(streamText(id)).toBe("🙃 done");
    updateClaudeChatMessage(id, "🙃 done 🎉"); // then a pure append of another astral char
    expect(streamText(id)).toBe("🙃 done 🎉");
    expect(streamText(id)).not.toContain("�");
    finalizeClaudeChatMessage(id);
    expect((chatMap().get(id) as ChatMessage).text).toBe("🙃 done 🎉");
  });
});
