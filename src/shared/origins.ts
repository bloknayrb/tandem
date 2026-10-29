/**
 * Origin-tagged Y.Doc transaction wrappers (ADR-031).
 *
 * Every Y.Doc write — server-side or browser-side — MUST go through one of
 * the six helpers below. Direct `*.transact()` calls outside this file are
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
 * ONE keyed exception to the channel column (#2069): CTRL_ROOM `documentMeta`'s
 * tab-list keys (`openDocuments`, `activeDocumentId`) derive `document:opened` /
 * `closed` / `switched` for EVERY origin except `mcp` — see
 * {@link shouldSkipDocumentLifecycle}. Their only writer is the server's own
 * `broadcastOpenDocs`, under `internal`, so under the table's rule those events
 * could never fire.
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
 * Origin for the WS-A2 `heldInSolo` marker LIFECYCLE — both halves: the
 * Solo→Tandem release pass, which clears the markers across open docs, and the
 * server-side stamp (`server/annotations/held-in-solo.ts`, #1769), which sets one
 * on a user comment created or edited while the room does not read Tandem.
 * Channel SKIPS (this is not a fresh user
 * action — the underlying annotations/replies are released via the checkInbox
 * pull path, not a re-emitted edit event; a channel `annotation:edited` here
 * would be a spurious duplicate). Durable-sync PERSISTS (the cleared marker MUST
 * reach disk, else a restart right after release re-reads a stale
 * `heldInSolo:true` and, under indeterminate mode, re-holds an already-released
 * item). Tombstone observer records, like every other origin.
 *
 * Channel-skip is also what makes the stamp observer's own re-entry impossible:
 * it bails on `shouldSkipChannel(txn.origin)`, so its nested write fires neither
 * it nor any channel observer.
 *
 * NOTE: this profile (channel-skip / durable-persist / tombstone) currently
 * mirrors `mcp`'s exactly — but a server-owned marker write is NOT a
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

/**
 * Should the CTRL_ROOM `documentMeta` observer skip a write to the tab-list keys
 * (`openDocuments`, `activeDocumentId`) — i.e. derive no `document:*` event from
 * it? (#2069)
 *
 * The one exception to {@link shouldSkipChannel}, and narrower than it on
 * purpose. Those keys are written only by `broadcastOpenDocs`
 * (`documents/registry.ts`), always under `withInternal` because they are
 * server bookkeeping mirrored to clients — so the general channel rule made
 * `document:opened` / `closed` / `switched` unreachable, while the local-model
 * collaborator's abort-on-close/switch and the channel shim's advertised
 * lifecycle events depended on them. The tab list changing IS the event,
 * whoever wrote it, so every origin emits except `mcp`, kept as the single skip
 * for a future Claude-initiated write that should not echo back at Claude.
 *
 * Applies to those two keys ONLY. Every other key in that map, and every other
 * observer, stays on `shouldSkipChannel`. A future `file-sync`, `reload` or
 * `mode-release` writer of those keys would emit; none exists today.
 */
export function shouldSkipDocumentLifecycle(origin: unknown): boolean {
  return origin === MCP_ORIGIN;
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

/** Wrap a WS-A2 `heldInSolo` marker write — the release clear or the server-side
 * stamp. Channel skips (no spurious edit events), durable-sync persists (the
 * marker state must survive restart). See the `MODE_RELEASE_ORIGIN` doc comment. */
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
