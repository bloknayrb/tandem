import type { Server } from "node:http";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { SRC_FILES } from "../helpers/src-tree.js";

/**
 * Source and wire pins the ownership identity rests on (#2358, ADR-054).
 */

describe("each transport branch tells the ownership module its mode before serving (ownership design §3.1 rule 4)", () => {
  // `main()` cannot be run in a unit test (tests/server/index.startup-ordering.test.ts
  // says why), so its order is pinned from source, as that file pins others.
  const src = SRC_FILES.get("src/server/index.ts") as string;
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `index.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("HTTP: mode, then the boot default rule, then the servers start", () => {
    const branch = at('if (transportMode === "http") {\n    // Ownership');
    const mode = at('setOwnershipTransportMode("http");');
    const boot = src.indexOf("applyUserOpenDefaultToDocuments(getOpenDocs().keys());", branch);
    const start = at("const [srv] = await Promise.all([");
    expect(branch < mode && mode < boot && boot < start).toBe(true);
  });

  it("stdio: mode, then the boot default rule, then Hocuspocus and MCP start", () => {
    const mode = at('setOwnershipTransportMode("stdio");');
    const boot = src.indexOf("applyUserOpenDefaultToDocuments(getOpenDocs().keys());", mode);
    const hocus = src.indexOf("await startHocuspocus(wsPort);", mode);
    const mcp = at("await startMcpServerStdio({ wsPort, mcpPort });");
    expect(mode < boot && boot < hocus && hocus < mcp).toBe(true);
    // Each mode is set exactly once, as a literal, never from the env string.
    expect(src.match(/setOwnershipTransportMode\(/g)).toHaveLength(2);
    expect(src).not.toMatch(/setOwnershipTransportMode\(\s*transportMode/);
  });
});

describe("no server log line prints a raw session id", () => {
  /**
   * Under the flag every `Mcp-Session-Id` and Claude session id a server log
   * line prints goes through `sessionIdForLog`
   * (ownership design §11.1). This walks every `console.*` call in the files
   * that log them and fails on a template span that interpolates an id-shaped
   * name unwrapped. The exemptions are reviewed: each prints no id.
   */
  const FILES = [
    "src/server/mcp/server.ts",
    "src/server/mcp/transport-registry.ts",
    "src/server/sessions/ownership.ts",
    "src/server/launcher/supervisor.ts",
  ];
  const ID_SHAPED = /(?:^|[^A-Za-z])(?:[a-z]*[sS]essionId|clientId|ownerId|sid|id)\b/;
  const WRAPPED = /^sessionIdForLog\(/;

  it("every id-shaped interpolation in a console call is wrapped", () => {
    const naked: string[] = [];
    let spans = 0;
    for (const file of FILES) {
      const text = SRC_FILES.get(file) as string;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, inConsole: boolean): void => {
        const isConsole =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "console";
        const inside = inConsole || isConsole;
        if (inside && ts.isTemplateSpan(node)) {
          spans++;
          const expr = node.expression.getText(sf);
          // A span holding a nested template is judged by the nested spans,
          // which this walk visits on its own.
          let nested = false;
          node.expression.forEachChild(function find(n): void {
            if (ts.isTemplateExpression(n)) nested = true;
            else n.forEachChild(find);
          });
          if (!nested && ID_SHAPED.test(expr) && !WRAPPED.test(expr)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            naked.push(`${file}:${line + 1} \${${expr}}`);
          }
        }
        ts.forEachChild(node, (child) => visit(child, inside));
      };
      visit(sf, false);
    }
    expect(spans).toBeGreaterThan(20);
    expect(naked).toEqual([]);
  });
});

describe("the identity headers stay out of CORS (ownership design §11.1)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await closeMcpSession();
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  });

  it("/api allows only Content-Type as a request header, and /mcp grants no origin", async () => {
    const port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const api = await fetch(`${base}/api/open`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-tandem-client-id, x-claude-session-id",
      },
    });
    await api.text();
    expect(api.headers.get("access-control-allow-headers")).toBe("Content-Type");
    const mcp = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-tandem-client-id",
      },
    });
    await mcp.text();
    expect(mcp.headers.get("access-control-allow-origin")).toBeNull();
    expect(mcp.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe("an ownerId is never published (ADR-054; OwnerRecord.ownerId)", () => {
  // An ownerId carries a raw header value (an `Mcp-Session-Id` is a bearer
  // value for its transport), so whatever a person or another session sees
  // names the record by its label. The files that may mention `ownerId` at all
  // are the identity plumbing; a new one (PR 5's `broadcastOpenDocs`, a
  // diagnostics route) joins this list only after review shows it publishes
  // the label instead.
  it("only the identity plumbing mentions ownerId in src", () => {
    const files = [...SRC_FILES]
      .filter(([f]) => /\.(ts|svelte)$/.test(f))
      .filter(([, src]) => /\bownerId\b/.test(src))
      .map(([f]) => f)
      .sort();
    expect(files).toEqual([
      "src/server/mcp/response.ts",
      "src/server/mcp/server.ts",
      "src/server/mcp/transport-registry.ts",
      "src/server/sessions/caller.ts",
      "src/server/sessions/context.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });
});
