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
    const pending = broker.request("applyPatchApproval", {
      reason: "edit",
      fileChanges: { "src/a.ts": { update: { unified_diff: "@@\n+added\n-gone\n" } } },
    });

    const [view] = broker.list();
    expect(view.changes).toEqual([
      {
        path: "src/a.ts",
        kind: "update",
        diff: "@@\n+added\n-gone\n",
        added: 1,
        removed: 1,
      },
    ]);
    expect(broker.decide(pending.id, "acceptForSession")).toBe(true);
    await expect(pending.result).resolves.toEqual({ decision: "approved_for_session" });
  });

  it("refuses a session-long write grant when the change set is unreadable", async () => {
    const broker = new CodexApprovalBroker();
    // No recognisable change set: the user would be granting writes for the rest
    // of the session without ever being shown a single path.
    const pending = broker.request("applyPatchApproval", { reason: "edit" });

    expect(broker.list()[0]?.allowForSession).toBe(false);
    expect(broker.decide(pending.id, "acceptForSession")).toBe(false);
    // One-shot approval is still available — only the standing grant is withheld.
    expect(broker.decide(pending.id, "accept")).toBe(true);
    await expect(pending.result).resolves.toEqual({ decision: "approved" });
  });

  it("keeps paths when a diff is too large to show, and says so", async () => {
    const broker = new CodexApprovalBroker();
    broker.request("item/fileChange/requestApproval", {
      grantRoot: "C:/repo",
      changes: [{ path: "big.txt", kind: "add", content: `${"x".repeat(50_000)}\n` }],
    });

    const [view] = broker.list();
    expect(view.grantRoot).toBe("C:/repo");
    expect(view.changes?.[0]?.path).toBe("big.txt");
    expect(view.changes?.[0]?.diffTruncated).toBe(true);
    expect(view.changes?.[0]?.diff?.length).toBeLessThanOrEqual(4_000);
    // Counted from the full text, so the size is honest even when the body is not shown.
    expect(view.changes?.[0]?.added).toBe(1);
    expect(view.allowForSession).toBe(true);
  });

  it("collapses a newline inside a path so it cannot forge an extra row", () => {
    const broker = new CodexApprovalBroker();
    broker.request("applyPatchApproval", {
      fileChanges: { "safe.ts\nevil.ts": { delete: {} } },
    });

    expect(broker.list()[0]?.changes?.[0]?.path).toBe("safe.ts evil.ts");
  });

  it("authenticates only the exact worker token", () => {
    const broker = new CodexApprovalBroker();
    expect(broker.authenticateWorker(broker.workerToken)).toBe(true);
    expect(broker.authenticateWorker(`${broker.workerToken}x`)).toBe(false);
    expect(broker.authenticateWorker(undefined)).toBe(false);
  });
});
