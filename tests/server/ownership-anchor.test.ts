import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpSuccess,
  noCallerRefusalMessage,
  withErrorBoundary,
} from "../../src/server/mcp/response.js";
import { ownershipEnabled } from "../../src/server/ownership-flag.js";
import { runWithMcpContext } from "../../src/server/sessions/context.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";

/**
 * The positive anchor of the `ownership-flag-on` CI job (#2358, ADR-054;
 * ownership design §12).
 *
 * Every other ownership test turns the flag on for itself with `vi.stubEnv`, so
 * it runs in `check` too. This file is the opposite: it **never** stubs the
 * variable and runs only when the process itself is flag-on. In `check` (flag
 * off) both tests skip; in `ownership-flag-on` they must run and pass, and
 * `scripts/ci/ownership-flag-on-runner.mjs` refuses the job unless every
 * assertion here reports `passed`. So a flag-on job whose `TANDEM_OWNERSHIP`
 * never reached the test workers reads red, not green.
 *
 * Only this file may key a test on the flag (`tests/server/ownership-module-seam.test.ts`
 * pins that): a second `runIf` elsewhere would be a test that silently never
 * runs in `check`.
 *
 * What it asserts is something only a flag-on process can make true: a wrapped
 * tool called with no caller is refused before its body runs.
 */

afterEach(() => {
  resetOwnershipForTests();
});

describe("ownership-flag-on anchor", () => {
  it.runIf(ownershipEnabled())("sees the job's TANDEM_OWNERSHIP=1 itself, not a stub", () => {
    // Separately from what ownershipEnabled() reports: the variable the
    // workflow's Test step sets reached this worker. This file never stubs it
    // (tests/server/ownership-module-seam.test.ts pins its source), so this
    // fails if anything between the step and the worker dropped it.
    expect(process.env.TANDEM_OWNERSHIP).toBe("1");
  });

  it.runIf(ownershipEnabled())("refuses a tool call that carries no caller", async () => {
    const body = vi.fn(async () => mcpSuccess({ ran: true }));
    const result = await withErrorBoundary("tandem_anchor", body)({});
    expect(body).not.toHaveBeenCalled();
    const envelope = JSON.parse(result.content[0].text) as { code: string; message: string };
    expect(envelope.code).toBe("INTERNAL_ERROR");
    expect(envelope.message).toBe(noCallerRefusalMessage("tandem_anchor"));
  });

  it.runIf(ownershipEnabled())("hands a dispatched caller's owner record to the body", async () => {
    const body = vi.fn(async (_args: Record<string, unknown>, caller: { ownerId?: string }) =>
      mcpSuccess({ ownerId: caller.ownerId }),
    );
    const result = await runWithMcpContext({ ownerId: "http:anchor" }, () =>
      withErrorBoundary("tandem_anchor", body)({}),
    );
    expect(body).toHaveBeenCalledOnce();
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: false,
      data: { ownerId: "http:anchor" },
    });
  });
});
