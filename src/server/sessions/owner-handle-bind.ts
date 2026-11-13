/**
 * The bind fact (#2358 PR 3a, Requirement 3, Rulings A and B).
 *
 * One fact per MCP transport: whether its `initialize` bound it to the current
 * spawn of Tandem's own Claude. A transport is bound when its `initialize`
 * carried the current spawn's owner handle (`X-Tandem-Owner-Handle`) AND an
 * `X-Claude-Session-Id` equal to that spawn's session id (R3.1). Anything else
 * is not bound, and the `initialize` succeeds all the same (R3.2).
 *
 * **Nothing reads the fact in 3a except tests** (R3.7): record resolution is
 * exactly as on master (Ruling A). 3b is its first reader.
 *
 * The meeting point of the launcher and the MCP server, which must not import
 * each other: the supervisor registers each spawn's state here, and
 * `mcp/server.ts` judges each `initialize` against it. A module singleton like
 * the other per-process registries; it imports no flag. Its callers do the
 * gating: the supervisor registers nothing while ownership is off, and the
 * server reads the header only while it is on.
 *
 * Only a spawn's own state holds the handle's value (R3.5). A transport, its
 * registry entry and every snapshot here hold the spawn's serial, never the
 * handle.
 */

import { timingSafeEqual } from "node:crypto";
import { isOwnerHandleShape } from "../../shared/owner-handle.js";

/** One spawn's bind state (R4.1). Created by the supervisor before the run
 * files are written; current only once its child has been started. */
export interface SpawnBind {
  /** Process-unique, never reused. What a bound transport records. */
  readonly serial: number;
}

interface SpawnState extends SpawnBind {
  readonly handle: Buffer;
  readonly sessionId: string;
  started: boolean;
  ended: boolean;
  /** Mcp-Session-Ids of transports bound to this spawn and still registered. */
  readonly bound: Set<string>;
  /** Fired once, on this spawn's first bind (deletes the run MCP config, R4.2). */
  onFirstBind?: () => void;
  firstBindFired: boolean;
}

let nextSerial = 1;
const spawns = new Map<number, SpawnState>();
/** The current spawn: the most recent one whose child was started and that has
 * not been torn down (brief, Terms). */
let current: SpawnState | null = null;
/** Ruling D7's limiter: the spawn whose not-bound line was logged, and when the
 * last not-bound line with no current spawn was logged. */
let unboundLoggedForSerial: number | null = null;
/** How many spawns became current while an EARLIER spawn's state was still
 * started and not ended. The supervisor's invariant is that this stays 0: a
 * new child starts only after the previous spawn's `discard` ran (every path
 * to `spawn()` passes `child === null`, and every path that nulls `child`
 * tears the spawn down first). The spawn and chain test suites assert it after
 * every test. `confirmBind`'s and `endSpawn`'s identity checks are defence in
 * depth behind it. */
let startOverlaps = 0;
let unboundLoggedWithoutSpawnAt: number | null = null;
const UNBOUND_LOG_INTERVAL_MS = 60_000;

/** Register a spawn's state. Not current until {@link markSpawnStarted}. */
export function registerSpawn(opts: {
  handle: string;
  sessionId: string;
  onFirstBind?: () => void;
}): SpawnBind {
  const state: SpawnState = {
    serial: nextSerial++,
    handle: Buffer.from(opts.handle, "utf8"),
    sessionId: opts.sessionId,
    started: false,
    ended: false,
    bound: new Set(),
    onFirstBind: opts.onFirstBind,
    firstBindFired: false,
  };
  spawns.set(state.serial, state);
  return { serial: state.serial };
}

/** The spawn's child has been started (`spawn()` returned): it is now the
 * current spawn, replacing any earlier one. A spawn already ended stays ended. */
export function markSpawnStarted(spawn: SpawnBind): void {
  const state = spawns.get(spawn.serial);
  if (!state || state.ended) return;
  for (const other of spawns.values()) {
    if (other !== state && other.started && !other.ended) startOverlaps++;
  }
  state.started = true;
  current = state;
}

/**
 * A spawn's teardown (R4.3): its handle stops binding and its transports stop
 * counting as bound. Ends only its own state — a newer spawn is never touched,
 * which is what makes the superseded spawn's late teardown safe. Idempotent.
 * Moves no transport and no document (Ruling A).
 */
export function endSpawn(spawn: SpawnBind): void {
  const state = spawns.get(spawn.serial);
  if (!state) return;
  state.ended = true;
  state.bound.clear();
  state.onFirstBind = undefined;
  state.handle.fill(0);
  spawns.delete(state.serial);
  if (current === state) current = null;
}

/** A bind candidate decided before the record is resolved (R3.9). */
export interface BindCandidate {
  readonly serial: number;
}

/**
 * Judge an `initialize`'s handle header against the current spawn. The shape
 * is checked before any comparison, and the comparison is constant-time
 * (R3.5). `null` when not bound, for any reason.
 */
export function judgeBind(
  rawHandle: string | undefined,
  claudeSessionId: string | undefined,
): BindCandidate | null {
  if (!isOwnerHandleShape(rawHandle)) return null;
  const spawn = current;
  if (spawn === null || !spawn.started || spawn.ended) return null;
  const presented = Buffer.from(rawHandle, "utf8");
  // Both are exactly 35 ASCII bytes once the shape holds; the length check is
  // what `timingSafeEqual` requires, not a shortcut.
  if (presented.length !== spawn.handle.length) return null;
  const handleMatches = timingSafeEqual(presented, spawn.handle);
  // A handle without the matching id never binds (R3.2), so a headerless
  // `curl` holding the handle does not.
  // Exact, on the same normalized string `resolveTransportRecord` keys on,
  // so 3b's rule 0 can never route a bound transport to a record whose id
  // differs from the spawn's.
  const idMatches = claudeSessionId !== undefined && claudeSessionId === spawn.sessionId;
  return handleMatches && idMatches ? { serial: spawn.serial } : null;
}

/**
 * Judge the candidate again after `registry.add`'s await (R3.9): a transport
 * is never recorded as bound to a spawn torn down (or superseded) meanwhile.
 * True when it is now bound; the spawn's first bind fires its `onFirstBind`.
 */
export function confirmBind(candidate: BindCandidate, mcpSessionId: string): boolean {
  const state = spawns.get(candidate.serial);
  // `current !== state` is defence in depth: under the supervisor's invariant
  // (see `startOverlaps`) a superseded spawn has already ended by the time its
  // successor is current, so `state.ended` alone would refuse it.
  if (!state || state.ended || current !== state) return false;
  state.bound.add(mcpSessionId);
  if (!state.firstBindFired) {
    state.firstBindFired = true;
    const cb = state.onFirstBind;
    state.onFirstBind = undefined;
    try {
      cb?.();
    } catch (err) {
      console.error("[Tandem] Owner handle: first-bind callback failed:", err);
    }
  }
  return true;
}

/** A transport left the registry (LRU eviction, the idle reaper, a `DELETE`):
 * its fact goes with it (R3.4). */
export function noteBoundTransportRemoved(mcpSessionId: string): void {
  for (const state of spawns.values()) state.bound.delete(mcpSessionId);
}

/** Whether the spawn `serial` is still live (registered, not torn down). */
export function isSpawnLive(serial: number): boolean {
  const state = spawns.get(serial);
  return state !== undefined && !state.ended;
}

/**
 * Ruling D7: a not-bound `initialize` that carried a handle header is logged at
 * most once per spawn and, while there is no current spawn, at most once per
 * minute. True when this one should be logged; records that it was.
 */
export function shouldLogUnboundHandle(now: number = Date.now()): boolean {
  if (current !== null) {
    if (unboundLoggedForSerial === current.serial) return false;
    unboundLoggedForSerial = current.serial;
    return true;
  }
  if (
    unboundLoggedWithoutSpawnAt !== null &&
    now - unboundLoggedWithoutSpawnAt < UNBOUND_LOG_INTERVAL_MS
  ) {
    return false;
  }
  unboundLoggedWithoutSpawnAt = now;
  return true;
}

/** Test-only (R3.7): serials and bound transport ids, never a handle. */
export function ownerHandleBindSnapshotForTests(): {
  current: number | null;
  spawns: Array<{ serial: number; started: boolean; bound: string[] }>;
  startOverlaps: number;
} {
  return {
    current: current?.serial ?? null,
    startOverlaps,
    spawns: [...spawns.values()].map((s) => ({
      serial: s.serial,
      started: s.started,
      bound: [...s.bound].sort(),
    })),
  };
}

/** Test-only: forget every spawn and the log limiter. */
export function resetOwnerHandleBindForTests(): void {
  for (const state of spawns.values()) state.handle.fill(0);
  spawns.clear();
  current = null;
  unboundLoggedForSerial = null;
  unboundLoggedWithoutSpawnAt = null;
  startOverlaps = 0;
}
