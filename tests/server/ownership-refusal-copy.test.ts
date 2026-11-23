import { describe, expect, it } from "vitest";
import type { HolderView, OwnershipRefusalReason } from "../../src/server/sessions/ownership.js";
import {
  chatReplyRefusal,
  documentBusyRefusal,
  FOCUS_NOT_MOVED_WARNING,
  holderPhrase,
  type NotDocOwnerInput,
  notDocOwnerRefusal,
  postRefusal,
} from "../../src/server/sessions/ownership-refusal.js";

/**
 * `NOT_DOC_OWNER` copy (#2358, ADR-054; ownership design §5.3, R4.2, R3.6).
 * Pure: the module reads no flag and no state. The refusals as tools return
 * them, built from real records, are in `ownership-enforcement.test.ts`.
 */

const terminal: HolderView = { label: "owner-k7qx", displayKind: "terminal" };
const tandem: HolderView = { label: "owner-zzzz", displayKind: "Tandem's Claude" };
const base = { documentId: "doc-1", holder: terminal } as const;

function message(input: Partial<NotDocOwnerInput> & { reason: OwnershipRefusalReason }): string {
  return notDocOwnerRefusal({ ...base, ...input }).message;
}

describe("one sentence per reason, each with its remedy", () => {
  it("switch: ask the user, do not open it", () => {
    expect(message({ reason: "switch" })).toBe(
      "The terminal session owner-k7qx has this document. Ask the user to click its tab; do not tandem_open it just to show it.",
    );
  });

  it("answered: names the answerer and says stop", () => {
    expect(message({ reason: "answered" })).toBe(
      "The terminal session owner-k7qx already answered this. Do not answer it again.",
    );
  });

  it("held: only the user can move it, it can still be read, no retry", () => {
    const text = message({ reason: "held" });
    expect(text).toContain("The terminal session owner-k7qx is working on this document.");
    expect(text).toContain("Only the user can reassign it");
    expect(text).toContain("You can still read it.");
    expect(text).toContain("Do not retry on this document.");
  });

  it("lost, cause taken: names the new holder", () => {
    const text = message({ reason: "lost", cause: "taken" });
    expect(text).toContain("The terminal session owner-k7qx has this document now.");
    expect(text).toContain("Only the user can reassign it");
  });

  it("lost, cause taken back: Tandem's Claude took it back, and when to open it again", () => {
    expect(message({ reason: "lost", cause: "taken back", holder: tandem })).toBe(
      "Tandem's Claude took this document back. You can still read it. Do not tandem_open it again unless the user asks you again after this point.",
    );
  });

  it("lost, cause released (PR 5a): the design's text, with or without a holder, never that the user chose it", () => {
    const released =
      "This document was released from you. You can still read it. Do not tandem_open it again unless the user asks you again after this point.";
    expect(message({ reason: "lost", cause: "released", holder: null })).toBe(released);
    expect(message({ reason: "lost", cause: "released", holder: tandem })).toBe(released);
  });

  it("lost, cause assigned (PR 5a): names the new holder, as taken does", () => {
    const text = message({ reason: "lost", cause: "assigned" });
    expect(text).toContain("The terminal session owner-k7qx has this document now.");
    expect(text).toContain("Only the user can reassign it");
  });

  it("lost, when the recipient is Tandem's Claude", () => {
    expect(message({ reason: "lost", cause: "taken", callerIsTandem: true })).toBe(
      "A session the user is working with has this document now; leave it.",
    );
  });

  it("claimed has a write sentence and an answer sentence", () => {
    const write = message({ reason: "claimed", family: "write" });
    expect(write).toContain("picked this document up while Tandem's Claude was away.");
    expect(write).toContain("Call tandem_open on it only if the user asked you");
    expect(write).toContain("An item Tandem handed or pushed to you is not such a request.");
    const answer = message({ reason: "claimed", family: "answer" });
    expect(answer).toContain("Do not answer this, and do not take the document because of it.");
    expect(answer).not.toBe(write);
  });

  it("default has a write sentence and an answer sentence", () => {
    const write = message({ reason: "default", family: "write", holder: tandem });
    expect(write).toContain("Tandem's Claude is answering this document.");
    expect(write).toContain("An item Tandem handed or pushed to you is not such a request.");
    const answer = message({ reason: "default", family: "answer", holder: tandem });
    expect(answer).toContain("Tandem's Claude answers this document's comments and chat.");
    expect(answer).toContain("do not take the document because of it");
  });

  it("not-present: leave the document, with no remedy that would loop", () => {
    const text = message({ reason: "not-present", holder: null, callerIsTandem: true });
    expect(text).toBe(
      "Tandem's Claude is turned off or stopped, so it holds no documents now. Leave this document.",
    );
    expect(text).not.toContain("tandem_open");
  });
});

describe("additions", () => {
  it("a defaulted target says so, warns about offsets, and lists what the caller holds", () => {
    const refusal = notDocOwnerRefusal({
      ...base,
      reason: "held",
      targetWasDefaulted: true,
      heldDocumentIds: ["mine-1"],
    });
    expect(refusal.message).toContain(
      "This call named no documentId, so it targeted the active document. If you meant a document you hold, pass its documentId; offsets read from this document do not apply to another.",
    );
    expect(refusal.details.heldDocumentIds).toEqual(["mine-1"]);
  });

  it("a named target carries neither the sentence nor the held ids", () => {
    const refusal = notDocOwnerRefusal({ ...base, reason: "held", heldDocumentIds: ["mine-1"] });
    expect(refusal.message).not.toContain("named no documentId");
    expect(refusal.details).not.toHaveProperty("heldDocumentIds");
  });

  it("a direct-HTTP Claude Code terminal is told to restart, on held / claimed / default only", () => {
    const restart = "restart this terminal";
    for (const reason of ["held", "claimed", "default"] as const) {
      expect(message({ reason, callerIsLegacyClaudeCode: true })).toContain(restart);
      expect(message({ reason })).not.toContain(restart);
    }
    for (const reason of ["switch", "answered", "lost", "not-present"] as const) {
      expect(message({ reason, callerIsLegacyClaudeCode: true })).not.toContain(restart);
    }
  });

  it("an open that ran before the take was lost says the document was opened", () => {
    expect(message({ reason: "held", openedAnyway: true })).toMatch(
      /^The document was opened \(or reloaded, if you passed force\) by this call, but you do not hold it/,
    );
  });

  it("the kept-focus warning says nothing is owed and not to open the document", () => {
    expect(FOCUS_NOT_MOVED_WARNING).toContain("Your position marker was not moved");
    expect(FOCUS_NOT_MOVED_WARNING).toContain("do not open the document for this");
  });
});

describe("what a refusal may say (R3.6)", () => {
  it("names a holder by the server's display kind and label only", () => {
    expect(holderPhrase(tandem)).toBe("Tandem's Claude");
    expect(holderPhrase(terminal)).toBe("The terminal session owner-k7qx");
    expect(holderPhrase({ label: "owner-aaaa", displayKind: "Claude Desktop" })).toBe(
      "Claude Desktop (owner-aaaa)",
    );
    expect(holderPhrase({ label: "owner-bbbb", displayKind: "other app" })).toBe(
      "Another app (owner-bbbb)",
    );
    expect(holderPhrase(null)).toBe("Another session");
  });

  it("details carry the reason, the document, the holder view and the cause, and no other key", () => {
    const { details } = notDocOwnerRefusal({ ...base, reason: "lost", cause: "taken" });
    expect(details).toEqual({
      reason: "lost",
      documentId: "doc-1",
      holder: { label: "owner-k7qx", displayKind: "terminal" },
      cause: "taken",
    });
  });

  it("the document id never appears in the message", () => {
    const reasons: OwnershipRefusalReason[] = [
      "switch",
      "answered",
      "lost",
      "held",
      "claimed",
      "default",
      "not-present",
      "unbound-child",
    ];
    for (const reason of reasons) {
      const text = message({ reason, documentId: "SECRET-NAME-9f3a", targetWasDefaulted: true });
      expect(text, reason).not.toContain("SECRET-NAME-9f3a");
    }
  });

  it("a holder object's extra fields are not copied into details", () => {
    const sneaky = { label: "owner-k7qx", displayKind: "terminal", ownerId: "http:secret" };
    const { details, message: text } = notDocOwnerRefusal({
      ...base,
      reason: "held",
      holder: sneaky as HolderView,
    });
    expect(JSON.stringify(details)).not.toContain("http:secret");
    expect(text).not.toContain("http:secret");
  });
});

describe("DOCUMENT_BUSY (the queue's wait bound)", () => {
  it("says nothing ran, bounds the retry, and tells an edit to re-read first", () => {
    const { message, details } = documentBusyRefusal({
      reason: "wait-expired",
      documentId: "doc-1",
      waitedMs: 20_000,
    });
    expect(message).toBe(
      "Another operation on this document has not finished, so this call was not run and nothing was changed. Retry once. If it is refused again, stop and tell the user: the document may be stuck on a slow save, and restarting Tandem clears it. If you are retrying an edit, read the document again first: the operation ahead of you may have changed it.",
    );
    expect(details).toEqual({ reason: "wait-expired", documentId: "doc-1", waitedMs: 20_000 });
  });

  it("names no holder and no document id in its message, for either reason", () => {
    for (const reason of ["wait-expired", "cancelled"] as const) {
      const { message, details } = documentBusyRefusal({ reason, documentId: "doc-1" });
      expect(message).not.toContain("doc-1");
      expect(message).not.toMatch(/owner-|session/);
      expect(message).toContain("nothing was changed");
      expect(Object.keys(details).sort()).toEqual(["documentId", "reason"]);
    }
  });
});

describe("the posts PR (R1.7): forms a post can get that the tool cannot reach yet", () => {
  const tandem = { label: "owner-tnd1", displayKind: "Tandem's Claude" } as const;
  const OUTLET =
    "Nothing was sent. If the user asked you in your own conversation to say this, tell them there.";

  it("post with no holder leaves the holder sentence out", () => {
    expect(postRefusal({ reason: "post", holder: null }).message).toBe(
      `To answer a user's chat message, pass its id as \`replyTo\`. Do not open or take a document in order to post. ${OUTLET}`,
    );
    // The same through the document builder's `post` row.
    expect(notDocOwnerRefusal({ reason: "post", documentId: "d", holder: null }).message).toBe(
      `To answer a user's chat message, pass its id as \`replyTo\`. Do not open or take a document in order to post. ${OUTLET}`,
    );
  });

  it("post naming a document the caller holds offers the documentId route", () => {
    expect(postRefusal({ reason: "post", holder: tandem, callerHolds: true }).message).toBe(
      `Tandem's Claude answers chat that is not about a document. To answer a user's chat message, pass its id as \`replyTo\`; to post about a document you hold, pass its \`documentId\`. Do not open or take a document in order to post. ${OUTLET}`,
    );
  });

  it("lost, taken back (PR 3b-2): true for a post", () => {
    expect(postRefusal({ reason: "lost", holder: tandem, cause: "taken back" }).message).toBe(
      `Tandem's Claude took this document back. You can still read it. Do not tandem_open it again unless the user asks you again after this point. ${OUTLET}`,
    );
  });

  it("lost, released (PR 5a): true for a post", () => {
    expect(postRefusal({ reason: "lost", holder: null, cause: "released" }).message).toBe(
      `This document was released from you. You can still read it. Do not tandem_open it again unless the user asks you again after this point. ${OUTLET}`,
    );
  });

  it("lost, a caller that is Tandem's Claude (PR 5): with and without a holder", () => {
    const term = { label: "owner-trm1", displayKind: "terminal" } as const;
    expect(
      postRefusal({ reason: "lost", holder: term, cause: "taken", callerIsTandem: true }).message,
    ).toBe("A session the user is working with has this document now; leave it. Nothing was sent.");
    expect(
      postRefusal({ reason: "lost", holder: null, cause: "taken", callerIsTandem: true }).message,
    ).toBe(
      "This document was taken from Tandem's Claude, and nobody holds it now. Nothing was sent.",
    );
  });

  it("lost, released, a caller that is Tandem's Claude (PR 5a): never says that a session has it", () => {
    expect(
      postRefusal({ reason: "lost", holder: null, cause: "released", callerIsTandem: true })
        .message,
    ).toBe(
      "This document was released from Tandem's Claude, and nobody holds it now. Nothing was sent.",
    );
    expect(message({ reason: "lost", cause: "released", holder: null, callerIsTandem: true })).toBe(
      "This document was released from you. You can still read it. Do not tandem_open it again unless the user asks you again after this point.",
    );
  });

  it("every post form names no message and no other session beyond the holder phrase, and carries no owner id", () => {
    for (const reason of ["post", "not-present", "lost", "held", "claimed", "default"] as const) {
      for (const holder of [null, tandem]) {
        const { message, details } = postRefusal({ reason, holder, documentId: "d" });
        expect(message).not.toMatch(/this message|answer this\b|Do not reply to it/i);
        expect(message).not.toMatch(/user chose|the user decided/i);
        expect(JSON.stringify(details)).not.toMatch(/claude:|bridge:|http:/);
        expect(Object.keys(details).sort()).toEqual(["documentId", "holder", "reason"].sort());
      }
    }
  });

  it("an answered chat reply's copy is the merged answered form", () => {
    expect(chatReplyRefusal({ reason: "answered", holder: tandem, why: "answered" })).toEqual({
      message: "Tandem's Claude already answered this. Do not answer it again.",
      details: { reason: "answered", holder: tandem },
    });
  });
});

describe("unbound-child (#2358 PR 3b-2b3b; design §5.3)", () => {
  const DOCUMENT =
    "Tandem's Claude answers this document. This connection shares Tandem's Claude's conversation but is not its own Tandem connection: either it is your second Tandem toolset, so use the other one, or this conversation was resumed outside Tandem, so leave this document unless the user assigns it to you from its tab.";

  it("a write or a take: the design's copy, whatever else the call carried", () => {
    expect(message({ reason: "unbound-child", holder: tandem })).toBe(DOCUMENT);
    const { details } = notDocOwnerRefusal({ ...base, reason: "unbound-child", holder: tandem });
    expect(details).toEqual({ reason: "unbound-child", documentId: "doc-1", holder: tandem });
    expect(
      message({ reason: "unbound-child", holder: tandem, callerIsLegacyClaudeCode: true }),
    ).toBe(DOCUMENT);
  });

  it("a reply to a message: the same copy for a message, and nothing was sent", () => {
    expect(
      chatReplyRefusal({ reason: "unbound-child", holder: tandem, why: "unbound-child" }),
    ).toEqual({
      message:
        "Tandem's Claude answers this message. This connection shares Tandem's Claude's conversation but is not its own Tandem connection: either it is your second Tandem toolset, so use the other one, or this conversation was resumed outside Tandem, so do not reply to it. Nothing was sent.",
      details: { reason: "unbound-child", holder: tandem },
    });
  });

  it("a post on a document: the document copy, and nothing was sent", () => {
    expect(postRefusal({ reason: "unbound-child", holder: tandem, documentId: "d" }).message).toBe(
      `${DOCUMENT} Nothing was sent.`,
    );
  });
});
