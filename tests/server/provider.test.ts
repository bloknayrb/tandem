import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createHocuspocusLifecycle } from "../../src/server/bootstrap/hocuspocus-lifecycle.js";
import { getOpenDocs } from "../../src/server/documents/registry.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getGenerationId, writeGenerationId } from "../../src/server/mcp/document-service.js";
import {
  assertAllowedOrigin,
  describeRejectedToken,
  getDocument,
  getOrCreateDocument,
  logOversizedFrame,
  MAX_SYNC_PAYLOAD_BYTES,
  removeDocument,
} from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../src/shared/constants.js";

describe("Y.Doc lifecycle (provider)", () => {
  it("getOrCreateDocument creates a new doc if none exists", () => {
    const doc = getOrCreateDocument("test-provider-create");
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(getDocument("test-provider-create")).toBe(doc);
  });

  it("getOrCreateDocument returns existing doc", () => {
    const doc1 = getOrCreateDocument("test-provider-idempotent");
    const doc2 = getOrCreateDocument("test-provider-idempotent");
    expect(doc1).toBe(doc2);
  });

  it("removeDocument clears the map entry", () => {
    getOrCreateDocument("test-provider-remove");
    expect(getDocument("test-provider-remove")).toBeDefined();
    const removed = removeDocument("test-provider-remove");
    expect(removed).toBe(true);
    expect(getDocument("test-provider-remove")).toBeUndefined();
  });

  it("getOrCreateDocument creates fresh doc after removeDocument", () => {
    const doc1 = getOrCreateDocument("test-provider-recycle");
    removeDocument("test-provider-recycle");
    const doc2 = getOrCreateDocument("test-provider-recycle");
    expect(doc2).not.toBe(doc1);
    expect(doc2).toBeInstanceOf(Y.Doc);
  });
});

describe("shouldKeepDocument (the installed lifecycle's predicate)", () => {
  afterEach(() => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
  });

  // These assert the PRODUCTION predicate from the composition root. They used
  // to build a local `(name) => openDocs.has(name) || name === CTRL_ROOM`
  // copy and assert on that, which could only ever confirm the test author's
  // model — the real predicate was free to drift underneath it. It is directly
  // reachable now that the four free setters are one named lifecycle.

  it("retains a document the registry still tracks, and stops when it does not", () => {
    const keep = createHocuspocusLifecycle().shouldKeepDocument;

    expect(keep("never-opened"), "control: an untracked room is evictable").toBe(false);

    addDoc("keep-me", {
      id: "keep-me",
      filePath: "/tmp/keep-me.md",
      format: "md",
      readOnly: false,
      source: "file",
    });
    expect(keep("keep-me"), "a tracked doc is retained").toBe(true);

    removeDoc("keep-me");
    expect(keep("keep-me"), "and is evictable the moment it is untracked").toBe(false);
  });

  it("retains CTRL_ROOM with nothing open at all", () => {
    // CTRL_ROOM is never an OpenDoc (ADR-033 rejected modelling it as one), so
    // its persistent chat history survives only because of this clause.
    expect(getOpenDocs().size, "control: nothing is open").toBe(0);
    expect(createHocuspocusLifecycle().shouldKeepDocument(CTRL_ROOM)).toBe(true);
  });
});

describe("assertAllowedOrigin (WebSocket origin gate)", () => {
  // This is the origin gate the Linux desktop actually hits on the Hocuspocus
  // WebSocket. Its correctness rests on the early `=== TAURI_LINUX_ORIGIN`
  // return running BEFORE `new URL()` — because `new URL("tauri://localhost")`
  // has hostname "localhost", which the 127.0.0.1/tauri.localhost check rejects.
  // A regression that reordered or dropped that early return would break Linux
  // sync silently (CI green), so these cases pin it.
  it("accepts the Linux Tauri origin tauri://localhost", () => {
    expect(() => assertAllowedOrigin(TAURI_LINUX_ORIGIN)).not.toThrow();
  });

  it("accepts the existing loopback + Windows origins", () => {
    expect(() => assertAllowedOrigin("http://127.0.0.1:5173")).not.toThrow();
    expect(() => assertAllowedOrigin("http://127.0.0.1:3479")).not.toThrow();
    expect(() => assertAllowedOrigin(`http://${TAURI_HOSTNAME}`)).not.toThrow();
  });

  it.each([
    ["a port suffix", "tauri://localhost:1234"],
    ["a trailing slash (must match the exact wire form)", "tauri://localhost/"],
    ["a hostname suffix", "tauri://localhost.evil"],
    ["a replaced host", "tauri://evil.example"],
    ["a different scheme to the same host", "https://localhost"],
    ["a bare localhost http origin (narrowed out in #477 PR 2)", "http://localhost:5173"],
  ])("rejects %s (%s)", (_why, origin) => {
    expect(() => assertAllowedOrigin(origin)).toThrow();
  });

  it("rejects a missing / empty origin", () => {
    expect(() => assertAllowedOrigin(undefined)).toThrow();
    expect(() => assertAllowedOrigin("")).toThrow();
  });
});

describe("writeGenerationId", () => {
  it("mints a generationId readable via getGenerationId()", () => {
    writeGenerationId();
    const genId = getGenerationId();
    expect(genId).toBeDefined();
    expect(typeof genId).toBe("string");
    expect((genId as string).length).toBeGreaterThan(0);
  });

  it("produces a different generationId on each call", () => {
    writeGenerationId();
    const first = getGenerationId();

    writeGenerationId();
    expect(getGenerationId()).not.toBe(first);
  });
});

// ── #1822, review round 1 — provider log hygiene and the 1009 signal ──────────

/** Written as escapes rather than literals: a raw ESC byte in a source file
 * is invisible in every diff view that would have to review it. */
const ESC = "\u001b";
const BEL = "\u0007";

describe("assertAllowedOrigin sanitizes the origin it logs (#1822 item 1, same class)", () => {
  // The origin is whatever the peer put on the WebSocket upgrade, and it is
  // read BEFORE authentication. `console.*` redirects to stderr (Critical
  // Rule 3), so an unstripped ESC/OSC-0 sequence retitles the operator's
  // terminal and a bare LF forges a whole log line. Hocuspocus binds 127.0.0.1
  // always, so this is loopback-only — the same control, at lower reach than
  // the channel routes.
  const OSC = `${ESC}]0;pwned${BEL}`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the escape from an unparseable origin", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertAllowedOrigin(`not a url${OSC}`)).toThrow();
    const line = spy.mock.calls.flat().join(" ");
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(BEL);
  });

  it("strips the escape from a parseable but disallowed origin", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A URL whose HOSTNAME is fine to parse but not allowlisted; the escape
    // rides in the path, which the log still interpolates verbatim.
    expect(() => assertAllowedOrigin(`http://evil.example/${OSC}`)).toThrow();
    const line = spy.mock.calls.flat().join(" ");
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(BEL);
  });
});

describe("describeRejectedToken (#1822 item 1 class — the pre-auth token log)", () => {
  it("strips an escape sequence that fits inside the eight-character slice", () => {
    // `ESC ]0;x BEL` is six characters, so the old `token.slice(0, 8)` did not
    // truncate the attack — it framed it. Sanitizing BEFORE the slice is what
    // makes the truncation irrelevant to the outcome.
    const rendered = describeRejectedToken(`${ESC}]0;x${BEL}abcdefgh`);
    expect(rendered).not.toContain(ESC);
    expect(rendered).not.toContain(BEL);
  });

  it("still truncates a long benign token to eight characters", () => {
    // The truncation is the privacy half and must survive the sanitize step:
    // a generation id is not a secret, but there is no reason to print it whole.
    expect(describeRejectedToken("a".repeat(64))).toBe(`"${"a".repeat(8)}\u2026"`);
  });

  it('answers "missing" for an absent or empty token', () => {
    expect(describeRejectedToken(undefined)).toBe("missing");
    expect(describeRejectedToken("")).toBe("missing");
  });
});

describe("logOversizedFrame (#1822 item 2 — the 1009 wedge is diagnosable)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs once, naming the cap, for ws's max-payload error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logOversizedFrame(
      Object.assign(new RangeError("Max payload size exceeded"), {
        code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls.flat().join(" ");
    // Naming the constant is the point: without it the operator sees a close
    // code and no reason. Assert the NUMBER, so a silent re-derivation of
    // MAX_SYNC_PAYLOAD_BYTES cannot leave the log describing the old bound.
    expect(line).toContain(String(MAX_SYNC_PAYLOAD_BYTES));
    expect(line).toContain("1009");
  });

  it("stays silent for every other socket error", () => {
    // An aborted connection is normal traffic. This is not a general ws error
    // log, and turning it into one would bury the signal it exists to raise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logOversizedFrame(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    logOversizedFrame(new Error("no code at all"));
    logOversizedFrame(undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});
