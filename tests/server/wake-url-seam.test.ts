/**
 * The `wakeUrl` seam: who can hand out a wake address, and who cannot.
 *
 * `src/server/mcp/wake-url.ts` says it is the single source of truth for which tools return
 * `wakeUrl`. That claim was written and then not enforced — the only "exclusion" assertion was
 * `expect(WAKE_URL_PRODUCERS).not.toContain("tandem_checkInbox")`, a tautology over a literal
 * the author controls, which cannot notice a `...wakeUrlField()` added to that tool's handler.
 * A fact stated in prose that nothing checks is precisely the bug the widening fixed, one layer
 * up, so this file exists to make the claim true rather than merely written.
 *
 * Keyed on SYMBOLS AND REACH, never on position. The tempting alternative — map each call site
 * to its enclosing `server.tool(` / `registerTool(` name — is silently wrong on today's source:
 * `tandem_status` is registered as `withErrorBoundary(` newline `"tandem_status"`
 * (`document.ts:1448`), so a "nearest preceding registration" inference attributes the call at
 * `:1505` to `tandem_save`. A confidently wrong answer is worse than no answer, so
 * this keys on symbols and reach instead.
 *
 * Four escapes this guards, three of which a naive importer-set-plus-count sweep misses:
 *
 *  (a) Bypassing the helper entirely with a direct `getWakeEndpoint()` spread. The importer set
 *      of `wakeUrlField` would be unchanged, so the "single source of truth" file would be
 *      routed around rather than violated.
 *  (b) An alias or re-export — `export const wakeUrlAddress = wakeUrlField;`. Not hypothetical:
 *      `annotation-reply-seam.test.ts` records reviewers defeating exactly this shape against an
 *      earlier seam test's first draft.
 *  (c) Moving a call rather than adding one. Covered BEHAVIOURALLY by
 *      `wake-url-surfacing.test.ts`, which calls every declared producer — not by this file.
 *  (d) Widening `toWireResult` instead of the tool payload, which would put a transport fact on
 *      `POST /api/open`, `/api/upload` and `/api/scratchpad` where `res.json` takes `unknown`.
 *      The `wakeUrl`-KEY pin below is what catches that; the helper pins cannot.
 *
 * If a second `wakeUrlField`-like helper ever appears, reach for the Critical Rule 9 shape
 * instead: one row per registered tool, `probed` / `not-probed` with a written reason, plus a
 * `listTools()` completeness net.
 */

import { describe, expect, it, vi } from "vitest";
import { WAKE_URL_PRODUCERS, wakeUrlField } from "../../src/server/mcp/wake-url.js";
import { runWithMcpContext } from "../../src/server/sessions/context.js";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

const WAKE_URL = "src/server/mcp/wake-url.ts";
const DOCUMENT = "src/server/mcp/document.ts";
const WAKE_SOCKET = "src/server/events/wake-socket.ts";

describe("the wakeUrl seam", () => {
  // The absent-vs-present-undefined invariant, asserted where it is actually observable.
  // Two of the three producers return via `mcpSuccess`, whose `JSON.stringify` drops an
  // undefined value — so a `{ wakeUrl: undefined }` bug is invisible through those tools and
  // any per-tool assertion of it is a guard that cannot fail (measured: 9/9 green with the bug
  // present). It is still a real invariant: `structuredContent` exposes the raw object for any
  // `mcpStructured` producer, where an undefined key reads to a strict client as a live
  // transport that is not running. Pin it on the helper, once.
  // #1952: outside a request context the helper fails closed even with a LIVE endpoint.
  it("yields NO key outside a request context, even with a wake transport running", async () => {
    const wakeSocket = await import("../../src/server/events/wake-socket.js");
    const spy = vi
      .spyOn(wakeSocket, "getWakeEndpoint")
      .mockReturnValue("ws://127.0.0.1:1/api/wake");
    try {
      expect(Object.keys(wakeUrlField())).toStrictEqual([]);
      expect(runWithMcpContext({ peerIsLoopback: true }, () => wakeUrlField())).toStrictEqual({
        wakeUrl: "ws://127.0.0.1:1/api/wake",
      });
    } finally {
      spy.mockRestore();
    }
  });

  // The narrow read §11.6 promises, and the one ownership PR 1a's context-getter seam test will
  // allowlist: wake-url.ts takes exactly one name from the context module, and it is the
  // boolean getter — never `getMcpContext` (which would hand it the session ids) or a direct
  // `peerIsLoopback` property read it could get wrong.
  it("reads the context module through isCurrentPeerLoopback alone", () => {
    const wu = stripComments(SRC_FILES.get(WAKE_URL) ?? "");
    const imports = [...wu.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)];
    const fromContext = imports.filter(([, , from]) => /sessions\/context(\.js)?$/.test(from));
    expect(fromContext, "wake-url.ts must import from sessions/context exactly once").toHaveLength(
      1,
    );
    expect(
      fromContext[0][1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    ).toStrictEqual(["isCurrentPeerLoopback"]);
    expect(wu).not.toMatch(/\bgetMcpContext\b|\bpeerIsLoopback\b/);
    expect(wu.match(/\bisCurrentPeerLoopback\s*\(/g) ?? []).toHaveLength(1);
  });

  // The initialize branch and GET/DELETE never carry a tool response, so no behavioural spec can
  // observe `peerIsLoopback` there; this source pin is the only check on those paths. Both
  // places `server.ts` enters the request context must derive the field from the SOCKET.
  it("server.ts sets peerIsLoopback from the socket at every context entry", () => {
    const server = stripComments(SRC_FILES.get("src/server/mcp/server.ts") ?? "");
    const entries = server.match(/\brunWithMcpContext\s*\(/g) ?? [];
    const derived =
      server.match(/peerIsLoopback:\s*isLoopback\(req\.socket\.remoteAddress\)/g) ?? [];
    expect(entries.length, "control: no runWithMcpContext call found in server.ts").toBeGreaterThan(
      0,
    );
    expect(
      derived,
      "every runWithMcpContext entry must set peerIsLoopback from the socket",
    ).toHaveLength(entries.length);
    expect(server.match(/\bpeerIsLoopback\b/g) ?? [], "no other write of the field").toHaveLength(
      entries.length,
    );
  });

  it("yields NO key at all when there is no transport", async () => {
    const { getWakeEndpoint } = await import("../../src/server/events/wake-socket.js");
    // No wake socket is attached in this suite, so the real endpoint is null. Called as a
    // LOOPBACK peer: outside a context the helper is empty anyway (#1952), which would make
    // this spec pass for the wrong reason.
    expect(getWakeEndpoint()).toBeNull();
    expect(
      Object.keys(runWithMcpContext({ peerIsLoopback: true }, () => wakeUrlField())),
    ).toStrictEqual([]);
  });

  // Positive control. Every static guard in this repo carries one, because a sweep that read
  // nothing satisfies every "no unexpected callers" assertion below it.
  it("control: the source sweep actually read the tree", () => {
    expect(SRC_FILES.size, "the src sweep found no files").toBeGreaterThan(100);
  });

  it("wakeUrlField is reachable only from the one registrar that holds the producers", () => {
    expect(filesMentioning("wakeUrlField")).toStrictEqual([DOCUMENT, WAKE_URL]);
  });

  it("has exactly one call site per declared producer", () => {
    const doc = stripComments(SRC_FILES.get(DOCUMENT) ?? "");
    expect(doc.match(/\bwakeUrlField\s*\(/g) ?? []).toHaveLength(WAKE_URL_PRODUCERS.length);
  });

  // Escape (a). `getWakeEndpoint` is a plain export of wake-socket.ts; nothing but this makes
  // `wake-url.ts` its only consumer, and a direct spread elsewhere satisfies every pin above.
  it("getWakeEndpoint reaches nothing but its definer and wake-url.ts", () => {
    expect(filesMentioning("getWakeEndpoint")).toStrictEqual([WAKE_SOCKET, WAKE_URL]);
  });

  // Escape (b). The capability must not be handed on under another name.
  it("hands the capability on to nobody", () => {
    const wu = stripComments(SRC_FILES.get(WAKE_URL) ?? "");
    expect(wu.match(/\bwakeUrlField\b/g) ?? [], "the declaration and nothing else").toHaveLength(1);
    expect(wu).not.toMatch(/export\s+(?:const|let|var|function)\s+\w+\s*=?\s*wakeUrlField\b/);
    expect(wu).not.toMatch(/export\s*\{[^}]*\bwakeUrlField\b[^}]*\bas\b/);
  });

  // Escape (d). The KEY, not the helper — `\bwakeUrl\b` does not match `wakeUrlField`, so
  // `document.ts` is absent here (its only bare `wakeUrl` mentions are comments, which
  // `stripComments` removes). That absence is the assertion: the moment `wakeUrl` is written
  // into `toWireResult` or any other shared projection, this set grows.
  it("the wakeUrl key exists only on the tool payload and the surfaces that name it", () => {
    expect(filesMentioning("wakeUrl")).toStrictEqual([
      "src/server/mcp/output-schemas.ts", // statusOutputShape's declared field
      "src/server/mcp/server.ts", // SERVER_INSTRUCTIONS prose
      WAKE_URL, // the local inside wakeUrlField
    ]);
  });
});
