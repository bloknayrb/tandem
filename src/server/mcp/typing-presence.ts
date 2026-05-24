/**
 * Claude typing-presence middleware (#651).
 *
 * Wraps MCP tool handlers to write a transient "Claude is working" marker into
 * the per-document `Y_MAP_AWARENESS` map under the `Y_MAP_CLAUDE` sub-key
 * (extending `ClaudeAwareness.working`). The marker carries the tool name and,
 * when applicable, the targeted annotationId so per-card UI can render an
 * inline typing-dot indicator.
 *
 * Critical correctness invariants:
 *
 *   1. All Y.Doc writes go through `withMcp` from `src/shared/origins.ts`.
 *      `withMcp` puts the transaction origin in the channel-skip set
 *      (`shouldSkipChannel('mcp')`), so the presence writes never produce
 *      SSE events — Claude won't see its own self-presence echoed back via
 *      `tandem_checkInbox` or the channel SSE stream.
 *
 *   2. ADR-027: `annotationId` is broadcast ONLY when the targeted annotation
 *      type is NOT `"note"`. Notes are user-private; surfacing their existence
 *      via awareness would leak the note ID. Callers that target a note must
 *      pass `annotationId: undefined` (the helper does this automatically when
 *      `sanitizeAnnotationIdForPresence` returns undefined).
 *
 *   3. A module-level 30s timeout sweeps stale entries so a hung handler (or a
 *      bug in finally-cleanup) never leaves a permanent typing indicator on a
 *      card. Sweep timer is module-state so vitest can stop it via
 *      `resetForTesting`.
 */

import * as Y from "yjs";
import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type { Annotation, ClaudeAwareness } from "../../shared/types.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { getCurrentDoc } from "./document.js";

/** Maximum lifetime of a single presence entry before the sweep clears it. */
export const TYPING_PRESENCE_TIMEOUT_MS = 30_000;

/** Sweep cadence — runs every 5s while there are any active entries. */
const SWEEP_INTERVAL_MS = 5_000;

interface ActiveEntry {
  tool: string;
  annotationId?: string;
  docName: string;
  /** Display-only wall-clock start (ms). */
  startedAt: number;
  /** Monotonic ownership token — the identity key for clear-by-owner. */
  token: number;
}

/**
 * Tracks every in-flight presence write. Keyed by a unique handle so concurrent
 * handlers (different tool calls in flight at once) don't stomp on each other.
 */
const active = new Map<symbol, ActiveEntry>();

/**
 * Module-level monotonic counter (#823). Used as the ownership key for the
 * `working` marker instead of `startedAt` (ms resolution), which collides when
 * two same-doc tool calls start in the same millisecond — one would clear the
 * other's still-active marker.
 */
let presenceTokenSeq = 0;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    const stale: symbol[] = [];
    for (const [handle, entry] of active) {
      if (now - entry.startedAt > TYPING_PRESENCE_TIMEOUT_MS) {
        stale.push(handle);
      }
    }
    for (const handle of stale) {
      const entry = active.get(handle);
      if (entry) {
        clearPresenceOn(entry.docName, entry.token);
        active.delete(handle);
      }
    }
    if (active.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the event loop open just for the sweep.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

/** Read the current `ClaudeAwareness` value, falling back to empty defaults. */
function readClaudeAwareness(awarenessMap: Y.Map<unknown>): ClaudeAwareness {
  const existing = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
  return (
    existing ?? {
      status: "",
      timestamp: 0,
      active: false,
      focusParagraph: null,
      focusOffset: null,
    }
  );
}

/** Compose a new ClaudeAwareness value with `working` set or cleared. */
function withWorking(prev: ClaudeAwareness, working: ClaudeAwareness["working"]): ClaudeAwareness {
  if (working == null) {
    // Strip the `working` field entirely on clear — keeps the serialized
    // snapshot identical to the pre-#651 shape so unrelated observers don't
    // diff on a `working: null` -> `working: undefined` no-op.
    const { working: _drop, ...rest } = prev;
    void _drop;
    return rest;
  }
  return { ...prev, working };
}

/** Set the presence marker on a specific document. */
function setPresenceOn(docName: string, marker: NonNullable<ClaudeAwareness["working"]>): void {
  const doc = getOrCreateDocument(docName);
  const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
  withMcp(doc, () => {
    const prev = readClaudeAwareness(awarenessMap);
    awarenessMap.set(Y_MAP_CLAUDE, withWorking(prev, marker));
  });
}

/**
 * Clear the presence marker on a specific document (no-op if absent).
 *
 * `expectedToken` is the monotonic ownership token that setPresenceOn wrote; if
 * the current `working` entry has a different token, another concurrent handler
 * owns the marker now and we MUST NOT clear it (overlapping tool calls —
 * finishing one shouldn't wipe the other's indicator). A monotonic counter is
 * collision-free even when two handlers start in the same millisecond (#823);
 * `startedAt` was not (ms resolution).
 *
 * The prev read happens INSIDE the withMcp transaction to avoid clobbering
 * an unrelated awareness write that lands between the read and the
 * transact (e.g. a concurrent `tandem_status` update).
 */
function clearPresenceOn(docName: string, expectedToken: number): void {
  const doc = getOrCreateDocument(docName);
  const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
  withMcp(doc, () => {
    const prev = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
    if (!prev || prev.working == null) return;
    if (prev.working.token !== expectedToken) return;
    awarenessMap.set(Y_MAP_CLAUDE, withWorking(prev, null));
  });
}

/**
 * Sanitize an annotationId for presence broadcast. Returns `undefined` if the
 * annotation is a note (per ADR-027 — broadcasting a note's ID confirms its
 * existence to Claude via awareness). Returns the input id if the annotation
 * type is safe to broadcast (`comment`, `highlight`, `flag`) or if no
 * annotation lookup applies (e.g. the id isn't in the map yet — defensive
 * fallback: when in doubt, drop it).
 *
 * Callers that always target a note (none in the current four-tool set) should
 * not pass an `annotationId` at all.
 */
export function sanitizeAnnotationIdForPresence(
  docName: string | undefined,
  annotationId: string | undefined,
  annotationsMapKey: string,
): string | undefined {
  if (!annotationId || !docName) return undefined;
  try {
    const doc = getOrCreateDocument(docName);
    const map = doc.getMap(annotationsMapKey);
    const ann = map.get(annotationId) as Annotation | undefined;
    if (!ann || typeof ann !== "object") return undefined;
    if (ann.type === "note") return undefined;
    return annotationId;
  } catch {
    // Defensive: any lookup failure means we can't prove it's safe — drop.
    return undefined;
  }
}

/**
 * Resolve the docName for a presence entry. Prefers an explicit `documentId`
 * (translated through `getCurrentDoc`), otherwise the active document. Returns
 * undefined when no document is open — presence is a no-op in that case.
 */
function resolveDocName(documentId: string | undefined): string | undefined {
  const current = getCurrentDoc(documentId);
  return current?.docName;
}

interface WithTypingPresenceOptions {
  /** Tool name (e.g. "tandem_comment"). Surfaced to the client UI. */
  tool: string;
  /**
   * Sanitized annotationId. The caller is responsible for running
   * `sanitizeAnnotationIdForPresence` BEFORE passing it here — never pass a
   * note's ID through this option.
   */
  annotationId?: string;
  /** Target document for the presence write. Falls back to active doc. */
  documentId?: string;
}

/**
 * Wrap an MCP handler with set-on-enter / clear-on-exit presence writes.
 *
 * The presence write is best-effort; any error during the set or clear is
 * logged but never propagated to the handler. The sweep timer catches anything
 * the finally clause misses (e.g. a synchronous throw outside the try block —
 * not possible today but cheap insurance).
 */
export async function withTypingPresence<T>(
  opts: WithTypingPresenceOptions,
  handler: () => Promise<T>,
): Promise<T> {
  const docName = resolveDocName(opts.documentId);
  // No open document — skip presence entirely. Handler still runs.
  if (!docName) {
    return handler();
  }

  const handle = Symbol("typing-presence");
  const startedAt = Date.now();
  const token = ++presenceTokenSeq;
  try {
    setPresenceOn(docName, {
      tool: opts.tool,
      ...(opts.annotationId ? { annotationId: opts.annotationId } : {}),
      startedAt,
      token,
    });
    active.set(handle, {
      tool: opts.tool,
      ...(opts.annotationId ? { annotationId: opts.annotationId } : {}),
      docName,
      startedAt,
      token,
    });
    ensureSweep();
  } catch (err) {
    console.error("[Tandem] withTypingPresence: failed to set presence:", err);
    // Fall through — handler still runs.
  }

  try {
    return await handler();
  } finally {
    try {
      // Pass our monotonic token so an overlapping concurrent handler that
      // took over the marker (a different token) is not stomped.
      clearPresenceOn(docName, token);
    } catch (err) {
      console.error("[Tandem] withTypingPresence: failed to clear presence:", err);
    }
    active.delete(handle);
    if (active.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }
}

/**
 * Test-only: stop the sweep timer and drop the active map. Vitest relies on
 * this to avoid leaking a pending interval across the test boundary.
 */
export function resetTypingPresenceForTesting(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  active.clear();
}
