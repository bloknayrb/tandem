/**
 * Every production local-model write carries `agentIdentity` (#1123 A2). The
 * stamp is the ONLY mark of local-model activity, which Claude is never handed
 * (decision 7): a write without it would read as Claude's own, and its
 * accepts, dismisses and the user's replies on it would be pushed, start
 * Claude and be handed. The write-side parameters are optional (tests build
 * contexts without one), so this pins the production wiring instead: the
 * config field is required, and both write paths are handed it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(join(process.cwd(), "src", "server", rel), "utf8");

describe("local-model writes carry agentIdentity (#1123 A2)", () => {
  it("the resolved config's identity is required, not optional", () => {
    expect(src("local-model/config.ts")).toMatch(/^\s+agentIdentity: AgentIdentity;$/m);
  });

  it("the tool dispatch (annotations and replies) is handed the config's identity", () => {
    expect(src("local-model/loop.ts")).toContain("agentIdentity: config.agentIdentity,");
  });

  it("the streamed chat reply is handed the config's identity", () => {
    expect(src("local-model/collaborator.ts")).toContain("agentIdentity: config.agentIdentity,");
  });

  it("every tool write in tools.ts passes the context's identity through", () => {
    const tools = src("local-model/tools.ts");
    // The three write sites: comment/suggestion creation and the reply.
    expect(tools.match(/ctx\.agentIdentity,/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
