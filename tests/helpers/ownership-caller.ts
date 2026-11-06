import { afterEach, beforeEach } from "vitest";
import {
  getMcpContext,
  type McpRequestContext,
  runWithMcpContext,
} from "../../src/server/sessions/context.js";
import {
  resetOwnershipForTests,
  setOwnershipTransportMode,
} from "../../src/server/sessions/ownership.js";

/**
 * Callers for tests that drive MCP tool handlers without the HTTP route
 * (#2358, ADR-054; ownership design §3.1, §12).
 *
 * With ownership on (the `ownership-flag-on` job), `withErrorBoundary` refuses
 * a tool call that carries no caller: in production every HTTP request is
 * dispatched inside a context naming its transport's owner record, and a
 * stdio-mode server answers as `local`. A test that calls a handler directly,
 * or through an in-memory transport, has neither — so it gets one here.
 *
 * Prefer the HTTP-shaped helpers (`asTestCaller`, `ownershipTestDispatch`):
 * they give the call a context, so the fail-closed default stays live in the
 * file. `useStdioOwnershipMode` is only for suites that boot
 * `startMcpServerStdio` in-process, which is `main()`'s stdio branch.
 *
 * Without the flag none of this changes anything: the context carries an
 * `ownerId` nobody reads.
 */

/** The record id a test caller resolves to unless it names one. */
export const TEST_OWNER_ID = "test:caller";

/**
 * Run `fn` as if dispatched to a registered HTTP transport: the surrounding
 * context, if any, with `ctx` over it and an `ownerId`.
 */
export function asTestCaller<T>(fn: () => T, ctx: Partial<McpRequestContext> = {}): T {
  return runWithMcpContext(
    { ...getMcpContext(), ...ctx, ownerId: ctx.ownerId ?? TEST_OWNER_ID },
    fn,
  );
}

/** `setupMcpServer`'s `dispatch` option: every message runs as the test caller. */
export const ownershipTestDispatch = <T>(fn: () => T): T => asTestCaller(fn);

/**
 * For suites that boot `startMcpServerStdio` in-process: tell the ownership
 * module this process is stdio mode, as `main()` does, before each test, and
 * forget it after.
 */
export function useStdioOwnershipMode(): void {
  beforeEach(() => {
    setOwnershipTransportMode("stdio");
  });
  afterEach(() => {
    resetOwnershipForTests();
  });
}
