import { describe, expect, it } from "vitest";
import type { HolderView, OwnershipRefusalReason } from "../../src/server/sessions/ownership.js";
import {
  documentBusyRefusal,
  FOCUS_NOT_MOVED_WARNING,
  holderPhrase,
  type NotDocOwnerInput,
  notDocOwnerRefusal,
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
