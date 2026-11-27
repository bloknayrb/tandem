import { afterEach, beforeEach } from "vitest";
import {
  getMcpContext,
  type McpRequestContext,
  runWithMcpContext,
} from "../../src/server/sessions/context.js";
import {
  noteTransportRegistered,
  resetOwnershipForTests,
  setOwnershipChatSide,
  setOwnershipTransportMode,
  setTransportView,
} from "../../src/server/sessions/ownership.js";

/**
 * Callers for tests that drive MCP tool handlers without the HTTP route
 * (#2358, ADR-054; ownership design §3.1, §12).
 *
 * With ownership on (the default since the flip), `withErrorBoundary` refuses
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

/**
 * For the generic suites that poll `tandem_checkInbox` as the test caller
 * (#2358 scope PR). Under inbox scope a poll by a caller with no owner record
 * reads no document, so with ownership on these suites would get empty
 * inboxes. This registers {@link TEST_OWNER_ID} as a real record before each
 * test (attached, never streamed: `openStreams: 0`, so a claim arms no grace),
 * so the suite's one caller reads every document it holds or may claim — in
 * a single-caller suite, every document — and claims what it is handed, as a
 * lone session does. Call it at a suite file's top level.
 *
 * Deliberately NOT part of `ownershipTestDispatch`, which about 37 files use:
 * there it would turn every flag-on write into a claim, and break suites that
 * pin the recordless caller (`mcp-write-precedence.test.ts`'s no-record arm,
 * PR 2a's recordless pin). Flag off it records nothing (the ownership module's
 * entry points return at once).
 *
 * It also wires the chat side as `src/server/index.ts` does (#2358, the chat
 * owners PR; review round 1, item 13), so a `tandem_reply` naming a stored
 * user message meets the real reply gate with the flag on rather than the
 * unwired seam's "no such message" (master's path). Flag off the gate answers
 * `legacy` whatever is wired.
 */
export function registerTestCallerRecord(): void {
  beforeEach(async () => {
    setTransportView(() => [{ ownerId: TEST_OWNER_ID, openStreams: 0 }]);
    noteTransportRegistered(TEST_OWNER_ID, { recordKind: "claude" });
    // Imported here, not at the top: a static import of the inbox from this
    // shared helper loads the MCP tool modules before a suite's hoisted
    // `vi.mock` factories can initialise (`convert-error-mapping.test.ts`).
    const { ownershipChatSide } = await import("../../src/server/mcp/awareness.js");
    setOwnershipChatSide(ownershipChatSide);
    // The delivery-round seam (#2358, the delivery-rounds PR; review round 1,
    // item 4), as `index.ts` wires it: flag on these suites then run keyed
    // rounds, the only combination a real server is in. Flag off it answers
    // false, so master's one global round, whatever is wired.
    const { setDeliveryRoundSeam } = await import("../../src/server/events/delivery-state.js");
    const { getOpenDocs } = await import("../../src/server/mcp/document-service.js");
    const { keyedDeliveryRounds } = await import("../../src/server/sessions/ownership.js");
    setDeliveryRoundSeam({
      keyed: keyedDeliveryRounds,
      isDocumentOpen: (documentId) => getOpenDocs().has(documentId),
    });
  });
  afterEach(async () => {
    const { setDeliveryRoundSeam } = await import("../../src/server/events/delivery-state.js");
    setDeliveryRoundSeam(undefined);
  });
}
