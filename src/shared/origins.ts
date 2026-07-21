/**
 * Origin-tagged Y.Doc transaction wrappers (ADR-031).
 *
 * Every Y.Doc write — server-side or browser-side — MUST go through one of
 * the five helpers below. Direct `*.transact()` calls outside this file are
 * surfaced (warn-only) by the `.claude/hooks/check-raw-transact.sh` PostToolUse
 * hook and the `npm run audit:origins` static walk — there is no blocking
 * pre-commit hook or Biome rule. The wrapper
 * choice is the contract: the rest of the system reads `txn.origin` and
 * decides whether to project events, persist to disk, record tombstones,
 * etc.
 *
 * | Origin        | Channel event queue | Durable-sync observer | Tombstone observer |
 * |---------------|---------------------|-----------------------|--------------------|
 * | `mcp`         | skip                | persist               | record             |
 * | `file-sync`   | skip                | skip                  | record             |
 * | `internal`    | skip                | skip                  | record             |
 * | `reload`      | skip                | persist               | record             |
 * | `browser`     | emit                | persist               | record             |
 * | `mode-release`| skip                | persist               | record             |
 *
 * Picking the wrong helper is a silent bug. See ADR-031 for the full
 * "how to choose" enumeration with worked examples.
 */

import type * as Y from "yjs";

// ---------------------------------------------------------------------------
// Origin constants
// ---------------------------------------------------------------------------

/** Origin for Claude-initiated writes from MCP tool handlers. */
export const MCP_ORIGIN = "mcp";

/** Origin for durable-annotation file-writer echoes (JSON → Y.Map sync). */
export const FILE_SYNC_ORIGIN = "file-sync";

/**
 * Origin for server-internal setup writes. See ADR-031's `withInternal`
 * worked examples — session restore, file population, tutorial / scratchpad
 * seeding, clear-and-reload (user-initiated force-reload), cleanup-after-
 * failure paths, server metadata broadcasts on CTRL_ROOM.
 */
export const INTERNAL_ORIGIN = "internal";

/**
 * Origin for the file-watcher mid-session `reloadFromDisk` flow. Channel
 * skips (not a user action), durable-sync persists (we want the re-anchored
 * relRanges saved), tombstone observer records.
 */
export const RELOAD_ORIGIN = "reload";

/** Origin for user edits originating in the browser (no current observer
 * filters on this — explicit label preserves the universal rule). */
export const BROWSER_ORIGIN = "browser";

/**
 * Origin for the WS-A2 Solo→Tandem release pass, which clears the persisted
 * `heldInSolo` markers across open docs. Channel SKIPS (this is not a fresh user
 * action — the underlying annotations/replies are released via the checkInbox
 * pull path, not a re-emitted edit event; a channel `annotation:edited` here
 * would be a spurious duplicate). Durable-sync PERSISTS (the cleared marker MUST
 * reach disk, else a restart right after release re-reads a stale
 * `heldInSolo:true` and, under indeterminate mode, re-holds an already-released
 * item). Tombstone observer records, like every other origin.
 *
 * NOTE: this profile (channel-skip / durable-persist / tombstone) currently
 * mirrors `mcp`'s exactly — but a server-owned mode-release sweep is NOT a
 * Claude-initiated MCP write, so it carries its own semantic identity (per
 * ADR-031 the helper choice IS the contract, and `audit:origins` reads it).
 * Keeping it distinct also lets the profile diverge later without touching mcp.
 */
export const MODE_RELEASE_ORIGIN = "mode-release";

export type TandemOrigin =
  | typeof MCP_ORIGIN
  | typeof FILE_SYNC_ORIGIN
  | typeof INTERNAL_ORIGIN
  | typeof RELOAD_ORIGIN
  | typeof BROWSER_ORIGIN
  | typeof MODE_RELEASE_ORIGIN;

// ---------------------------------------------------------------------------
// Skip-set predicates
// ---------------------------------------------------------------------------

/**
 * Origins that channel-event observers must skip — every internal-purpose
 * origin. Only `browser` produces channel events today.
 */
const CHANNEL_SKIP: ReadonlySet<unknown> = new Set([
  MCP_ORIGIN,
  FILE_SYNC_ORIGIN,
  INTERNAL_ORIGIN,
  RELOAD_ORIGIN,
  MODE_RELEASE_ORIGIN,
]);

/** Origins that the durable-annotation sync observer must skip. */
const DURABLE_SKIP: ReadonlySet<unknown> = new Set([FILE_SYNC_ORIGIN, INTERNAL_ORIGIN]);

export function shouldSkipChannel(origin: unknown): boolean {
  return CHANNEL_SKIP.has(origin);
}

export function shouldSkipDurableSync(origin: unknown): boolean {
  return DURABLE_SKIP.has(origin);
}

// ---------------------------------------------------------------------------
// Wrapper helpers
// ---------------------------------------------------------------------------

function runTransact<T>(doc: Y.Doc, fn: () => T, origin: TandemOrigin): T {
  let result: T | undefined;
  let captured = false;
  // biome-ignore lint/suspicious/noExplicitAny: Y.Doc.transact's second arg is `unknown`; passing a typed string is safe.
  (doc as any).transact(() => {
    result = fn();
    captured = true;
  }, origin);
  if (!captured) {
    // Should be unreachable — Y.Doc.transact invokes the callback synchronously.
    throw new Error(`origins: transact callback did not run (origin=${origin})`);
  }
  return result as T;
}

/** Wrap user-intent writes from MCP tool handlers. */
export function withMcp<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, MCP_ORIGIN);
}

/** Wrap echoes from the durable-annotation file-writer / file-watcher
 * reload path. The channel skips, the durable-sync observer skips. The
 * tombstone observer RECORDS (not skips) — see sync.ts observer comment. */
export function withFileSync<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, FILE_SYNC_ORIGIN);
}

/** Wrap server-internal setup writes — see the `INTERNAL_ORIGIN` doc
 * comment for the worked-example list. */
export function withInternal<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, INTERNAL_ORIGIN);
}

/** Wrap mid-session `reloadFromDisk` writes. Distinct from `withFileSync`:
 * the durable-sync observer PERSISTS reload writes so the re-anchored
 * relRanges land on disk. */
export function withReload<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, RELOAD_ORIGIN);
}

/** Wrap user edits originating in the browser. */
export function withBrowser<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, BROWSER_ORIGIN);
}

/** Wrap the WS-A2 Solo→Tandem release marker-clear. Channel skips (no spurious
 * edit events), durable-sync persists (the cleared marker must survive restart).
 * See the `MODE_RELEASE_ORIGIN` doc comment. */
export function withModeRelease<T>(doc: Y.Doc, fn: () => T): T {
  return runTransact(doc, fn, MODE_RELEASE_ORIGIN);
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Test-only transact wrapper for synthetic Y.Docs. Tagged with a sentinel
 * origin so observers and lint can distinguish from production transacts.
 * Allowlisted in the `block-raw-transact` hook via the helpers-file
 * exception.
 */
export const TEST_ORIGIN = "test";

export function transactForTest<T>(doc: Y.Doc, fn: () => T): T {
  let result: T | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: Y.Doc.transact's second arg is `unknown`.
  (doc as any).transact(() => {
    result = fn();
  }, TEST_ORIGIN);
  return result as T;
}
