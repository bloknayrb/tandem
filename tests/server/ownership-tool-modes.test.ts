import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import { registerDiagnosticsTools } from "../../src/server/mcp/diagnostics.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { TOOL_MODES, type ToolMode } from "../../src/server/mcp/tool-modes.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch } from "../helpers/ownership-caller.js";

/**
 * The tool-mode table is pinned against the tools as registered (#2358,
 * ADR-054; ownership design §5.1): "every tool falls in exactly one row … a
 * new tool fails the test until it is placed".
 *
 * Under vitest `.docx` is on (the root `test.env`), so `tandem_applyChanges`
 * and `tandem_convertToMarkdown` are registered here; a release registers
 * neither. The design's table also names deprecated `flag` / `suggest` stubs:
 * no such tools are registered, so they have no row.
 */

const REGISTRARS: Array<(server: McpServer) => void> = [
  registerDocumentTools,
  registerAnnotationTools,
  registerNavigationTools,
  registerAwarenessTools,
  registerApplyTools,
  (server) =>
    registerDiagnosticsTools(server, {} as Parameters<typeof registerDiagnosticsTools>[1]),
];

/**
 * The design's table, transcribed by hand. Deliberately NOT derived from
 * `TOOL_MODES`: a write tool quietly re-labelled `read` there must fail here.
 */
const DESIGN_TABLE: Record<ToolMode, string[]> = {
  write: [
    "tandem_edit",
    "tandem_appendContent",
    "tandem_editList",
    "tandem_applyChanges",
    "tandem_restoreBackup",
    "tandem_save",
    "tandem_rename",
    "tandem_close",
    "tandem_convertToMarkdown",
    "tandem_comment",
    "tandem_resolveAnnotation",
    "tandem_removeAnnotation",
    "tandem_editAnnotation",
    "tandem_annotationReply",
  ],
  take: ["tandem_open", "tandem_scratchpad"],
  reply: ["tandem_reply"],
  "owner-only": ["tandem_switchDocument"],
  status: ["tandem_status"],
  read: [
    "tandem_getTextContent",
    "tandem_getOutline",
    "tandem_getContext",
    "tandem_getAnnotations",
    "tandem_listDocuments",
    "tandem_search",
    "tandem_resolveRange",
    "tandem_getActivity",
    "tandem_exportAnnotations",
    "tandem_diagnostics",
    "tandem_checkInbox",
  ],
};

async function registeredTools(flag: "" | "1"): Promise<string[]> {
  // Literal calls, so the reviewed lists in ownership-module-seam.test.ts see
  // which files turn the flag on and which turn it off.
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  const { client, close } = await setupMcpServer(REGISTRARS, { dispatch: ownershipTestDispatch });
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await close();
  }
}

afterEach(() => {
  resetOwnershipForTests();
  vi.unstubAllEnvs();
});

describe("TOOL_MODES", () => {
  it.each(["", "1"] as const)(
    "has a row for exactly the registered tools (flag %j)",
    async (flag) => {
      expect(Object.keys(TOOL_MODES).sort()).toEqual(await registeredTools(flag));
    },
  );

  it("places every tool in the row the design gives it", () => {
    const byMode: Record<string, string[]> = {};
    for (const [tool, entry] of Object.entries(TOOL_MODES)) {
      (byMode[entry.mode] ??= []).push(tool);
    }
    for (const mode of Object.keys(DESIGN_TABLE) as ToolMode[]) {
      expect(byMode[mode]?.sort(), mode).toEqual([...DESIGN_TABLE[mode]].sort());
    }
    expect(Object.keys(byMode).sort()).toEqual(Object.keys(DESIGN_TABLE).sort());
  });

  it("names the two rows PR 1c does not enforce, and no other", () => {
    const later = Object.entries(TOOL_MODES)
      .filter(([, entry]) => entry.enforcedIn !== "1c")
      .map(([tool, entry]) => `${tool}:${entry.enforcedIn}`)
      .sort();
    // `tandem_reply`'s acceptance rules and the inbox's scope are PR 2's.
    expect(later).toEqual(["tandem_checkInbox:2", "tandem_reply:2"]);
  });
});
