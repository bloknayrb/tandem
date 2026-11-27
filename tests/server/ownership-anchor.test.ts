import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpSuccess,
  noCallerRefusalMessage,
  withErrorBoundary,
} from "../../src/server/mcp/response.js";
import { ownershipEnabled } from "../../src/server/ownership-flag.js";
import { runWithMcpContext } from "../../src/server/sessions/context.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { OWNERSHIP_ENABLED } from "../../src/shared/constants.js";

/**
 * The positive anchor of ownership's flag-on CI run (#2358, ADR-054;
 * ownership design §12), read by `check`'s "Ownership anchor ran flag-on" step.
 *
 * Every other ownership test turns the flag on for itself with `vi.stubEnv`, so
 * it runs in `check` too. This file is the opposite: it **never** stubs the
 * variable and runs only when the process itself is flag-on. Before the flip
 * it ran only in the `ownership-flag-on` job (since deleted), where
 * `scripts/ci/ownership-flag-on-runner.mjs` refused the run unless every
 * assertion here reported `passed`. Since the flip (ADR-054's flip amendment)
 * an unset variable follows the `true` literal, so it runs in `check`, whose
 * anchor step runs the same runner: a run that came out flag-off (the
 * variable set to anything but `"1"`, or the literal set back) skips it and
 * turns `check` red.
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
  it.runIf(ownershipEnabled())(
    "is on by the literal or by the job's TANDEM_OWNERSHIP=1, not a stub",
    () => {
      // Separately from what ownershipEnabled() reports: this worker is flag-on
      // either because nothing set the variable (the literal decides, as in
      // `check`) or because someone ran the suite with it set to "1" (as the
      // deleted ownership-flag-on job did). This file never stubs it
      // (tests/server/ownership-module-seam.test.ts pins its source).
      const variable = process.env.TANDEM_OWNERSHIP;
      if (variable === undefined) {
        expect(OWNERSHIP_ENABLED).toBe(true);
      } else {
        expect(process.env.TANDEM_OWNERSHIP).toBe("1");
      }
    },
  );

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
