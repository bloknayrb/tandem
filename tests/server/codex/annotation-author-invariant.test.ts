import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAnnotation } from "../../../src/server/mcp/annotations.js";
import { runWithMcpContext } from "../../../src/server/sessions/context.js";
import type { Annotation } from "../../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, rangeOf } from "../../helpers/ydoc-factory.js";

/**
 * ADR-027 / #1123 M3 invariant, now load-bearing for the Codex integration
 * too: `Annotation.author` is a ROLE ("user" | "claude" | "import"), not a
 * literal agent identity. Every privacy/gating branch (Solo-hold, the
 * channel-visibility filter, `tandem_getAnnotations` author filtering) keys
 * on that role. `agentIdentity` is a separate, purely-cosmetic byline stamp.
 *
 * A Codex-authored comment reaches `createAnnotation` exactly like the
 * local-model collaborator loop does (`src/server/local-model/tools.ts`'s
 * `annotateFromQuote`): it never sets `extras.author`, it only arranges for
 * `agentIdentity` to be present in the MCP request context (here: Codex's
 * `X-Tandem-Agent-Provider: openai` header, decoded in
 * `readAgentIdentityHeader` in `src/server/mcp/server.ts` to
 * `{ provider: "openai", displayName: "Codex" }`, and threaded through
 * `runWithMcpContext`). `createAnnotation` reads that context and merges
 * `agentIdentity` onto the record — this test pins that the merge cannot
 * also smuggle a different `author` in.
 */
describe("createAnnotation: author stays claude when Codex's agentIdentity is stamped", () => {
  let doc: Y.Doc;

  afterEach(() => {
    doc?.destroy();
  });

  const CODEX_IDENTITY = { provider: "openai", displayName: "Codex" } as const;

  it("stamps agentIdentity but leaves author === claude", () => {
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    const id = runWithMcpContext({ agentIdentity: CODEX_IDENTITY }, () =>
      createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "Consider rewording"),
    );

    const stored = map.get(id) as Annotation;
    expect(stored.author).toBe("claude");
    expect(stored.agentIdentity).toEqual(CODEX_IDENTITY);
  });

  it("positive control: outside any MCP request context, no agentIdentity is stamped at all", () => {
    // Proves the field genuinely depends on context being present — the
    // assertion above isn't just checking a value `createAnnotation` always
    // writes regardless of input.
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "Consider rewording");

    const stored = map.get(id) as Annotation;
    expect(stored.author).toBe("claude");
    expect(stored.agentIdentity).toBeUndefined();
  });

  it("positive control: author is NOT a hardcoded constant — extras can genuinely set it to something else", () => {
    // Demonstrates the mechanism CAN produce a different author (the "user"
    // role, used for e.g. imported/editor-originated records) — so "author
    // stays claude" above is a real assertion about the Codex/agentIdentity
    // path specifically, not an artifact of an unconditionally-fixed field.
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    const id = runWithMcpContext({ agentIdentity: CODEX_IDENTITY }, () =>
      createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "user-authored", {
        author: "user",
      }),
    );

    const stored = map.get(id) as Annotation;
    expect(stored.author).toBe("user");
  });

  it("an unrecognized/absent provider tag never reaches agentIdentity (mirrors readAgentIdentityHeader's fail-closed default)", () => {
    // Codex's own identity is asserted via the loopback-only
    // X-Tandem-Agent-Provider header; readAgentIdentityHeader returns
    // `undefined` for anything it doesn't recognize rather than inventing a
    // partial identity. createAnnotation must not manufacture one either —
    // an absent agentIdentity in the context must produce an annotation with
    // no agentIdentity field, still authored "claude".
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    const id = runWithMcpContext({}, () =>
      createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "no identity asserted"),
    );

    const stored = map.get(id) as Annotation;
    expect(stored.author).toBe("claude");
    expect(stored.agentIdentity).toBeUndefined();
  });
});
