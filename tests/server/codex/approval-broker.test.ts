import { describe, expect, it } from "vitest";

import { CodexApprovalBroker } from "../../../src/server/codex/approval-broker.js";

describe("CodexApprovalBroker", () => {
  it("exposes only bounded display fields and resolves a command approval", async () => {
    const broker = new CodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", {
      command: `echo safe\u001b[31m${"x".repeat(5_000)}`,
      cwd: "C:/repo",
      reason: "Needs a build",
      secretInternalField: "must-not-leak",
    });

    const [view] = broker.list();
    expect(view.id).toBe(pending.id);
    expect(view.kind).toBe("command");
    expect(view.command?.length).toBeLessThanOrEqual(4_000);
    expect(view.command).not.toContain("\u001b");
    expect(JSON.stringify(view)).not.toContain("secretInternalField");

    expect(broker.decide(pending.id, "accept")).toBe(true);
    await expect(pending.result).resolves.toEqual({ decision: "accept" });
    expect(broker.list()).toEqual([]);
  });

  it("maps session approval to the legacy app-server response", async () => {
    const broker = new CodexApprovalBroker();
    const pending = broker.request("applyPatchApproval", { reason: "edit" });
    expect(broker.decide(pending.id, "acceptForSession")).toBe(true);
    await expect(pending.result).resolves.toEqual({ decision: "approved_for_session" });
  });

  it("authenticates only the exact worker token", () => {
    const broker = new CodexApprovalBroker();
    expect(broker.authenticateWorker(broker.workerToken)).toBe(true);
    expect(broker.authenticateWorker(`${broker.workerToken}x`)).toBe(false);
    expect(broker.authenticateWorker(undefined)).toBe(false);
  });
});
