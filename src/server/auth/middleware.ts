/**
 * Auth middleware for non-loopback requests.
 *
 * Security invariants:
 * - Loopback detection uses req.socket.remoteAddress exclusively — Host header never used.
 *   ::ffff:127.0.0.1 and ::1 are normalized to 127.0.0.1 and treated as loopback.
 *   Undefined remoteAddress is treated as NON-loopback (fail-closed during socket teardown).
 * - Token compare: SHA-256 both sides → crypto.timingSafeEqual (eliminates length oracle;
 *   timingSafeEqual throws on length mismatch so we SHA-256 to a fixed 32-byte digest first).
 * - Rate-limit runs BEFORE token compare: uniform 401 for all pre-threshold failures.
 *   After 5 failures in 10 minutes the offending IP gets 429.
 * - Rejection logs NEVER include the Authorization header value.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Grace-window slot: the previous token remains valid for a short TTL after rotation. */
interface PreviousTokenSlot {
  value: string;
  expiresAt: number;
}

let _previousToken: PreviousTokenSlot | undefined;

/**
 * Record the old token so it remains valid during the rotation grace window.
 * Called by `POST /api/rotate-token` immediately before the new token takes effect.
 *
 * @param token - The old token value (plain text, not hashed).
 * @param ttlMs - How long to honour the old token (default: 60 seconds).
 */
export function setPreviousToken(token: string, ttlMs = 60_000): void {
  _previousToken = { value: token, expiresAt: Date.now() + ttlMs };
}

/** Read the current previous-token slot (undefined when not set or expired). */
export function getPreviousToken(): PreviousTokenSlot | undefined {
  if (!_previousToken) return undefined;
  if (Date.now() >= _previousToken.expiresAt) {
    _previousToken = undefined;
    return undefined;
  }
  return _previousToken;
}

/** Clear the previous-token slot (used in tests for isolation). */
export function clearPreviousToken(): void {
  _previousToken = undefined;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_MAX_ENTRIES = 1000;

interface FailEntry {
  count: number;
  windowStart: number;
}

/**
 * Derive the rate-limit key from a remote address.
 * IPv4 literals are used as-is.
 * IPv6 addresses are reduced to their /64 prefix (first 4 colon-separated segments).
 * Handles compressed :: notation by expanding to 8 segments first.
 * Already-normalized IPv4-mapped addresses ("127.0.0.1" after isLoopback) pass through.
 */
function rateLimitKey(addr: string): string {
  if (!addr.includes(":")) return addr; // plain IPv4
  const bare = addr.split("%")[0]; // strip zone identifier
  // IPv4-mapped — extract IPv4 part (already normalized away from loopback)
  const v4mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return v4mapped[1] as string;
  // Expand :: to fill 8 segments
  if (bare.includes("::")) {
    const [left, right] = bare.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const fill = Array(8 - head.length - tail.length).fill("0");
    const full = [...head, ...fill, ...tail];
    return full.slice(0, 4).join(":");
  }
  // Already fully expanded (8 segments, no ::)
  return addr.split(":").slice(0, 4).join(":");
}

/** Simple in-memory LRU-ish rate limiter using a Map with manual eviction. */
class RateLimiter {
  private readonly failures = new Map<string, FailEntry>();

  /** Returns true if the address is over the rate limit. Always call before the token compare. */
  isOverLimit(addr: string): boolean {
    const key = rateLimitKey(addr);
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry) return false;
    // Expired window — treat as fresh
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX_FAILURES;
  }

  /** Record a failure for the given address. */
  recordFailure(addr: string): void {
    const key = rateLimitKey(addr);
    const now = Date.now();
    const existing = this.failures.get(key);
    if (existing && now - existing.windowStart <= RATE_LIMIT_WINDOW_MS) {
      existing.count += 1;
    } else {
      // Evict oldest entries if we're at capacity (simple LRU via insertion order)
      if (this.failures.size >= RATE_LIMIT_MAX_ENTRIES) {
        const firstKey = this.failures.keys().next().value;
        if (firstKey !== undefined) this.failures.delete(firstKey);
      }
      this.failures.set(key, { count: 1, windowStart: now });
    }
  }

  /** Reset failures on successful auth. */
  reset(addr: string): void {
    this.failures.delete(rateLimitKey(addr));
  }
}

/**
 * Normalize a remote address to a canonical IPv4 string where applicable.
 * Returns the original string for non-loopback IPv6.
 */
function normalizeAddress(addr: string): string {
  if (addr === "::1") return "127.0.0.1";
  if (addr === "::ffff:127.0.0.1") return "127.0.0.1";
  return addr;
}

/**
 * Returns true iff the remote address is a loopback address.
 * Uses req.socket.remoteAddress only — Host header is never consulted.
 * Undefined is treated as non-loopback (fail-closed).
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  return normalizeAddress(remoteAddress) === "127.0.0.1";
}

/** SHA-256 a UTF-8 string; returns 32-byte Buffer. */
function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Create Express auth middleware that:
 * 1. Bypasses auth for loopback requests (Claude Code zero-config).
 * 2. Rate-limits non-loopback addresses (5 failures per 10 min → 429).
 * 3. Validates `Authorization: Bearer <token>` via constant-time SHA-256 compare.
 *
 * getToken() returns the current server token, or null if not yet loaded.
 * When null, all non-loopback requests are rejected (401).
 */
export function createAuthMiddleware(
  getToken: () => string | null,
): (req: Request, res: Response, next: NextFunction) => void {
  const limiter = new RateLimiter();

  return (req: Request, res: Response, next: NextFunction): void => {
    const addr = req.socket.remoteAddress;

    // Invariant 1: loopback bypass via socket address only, never Host header
    if (isLoopback(addr)) {
      next();
      return;
    }

    const normalizedAddr = addr !== undefined ? normalizeAddress(addr) : "<unknown>";

    // Rate-limit before token compare
    if (limiter.isOverLimit(normalizedAddr)) {
      res.status(429).json({ error: "Too Many Requests" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      limiter.recordFailure(normalizedAddr);
      // Do NOT include authHeader value in the log — invariant 5
      console.error(`[tandem] auth: rejected request from ${normalizedAddr} (no/bad token header)`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const presented = authHeader.slice("Bearer ".length);

    // Reject empty token before hashing
    if (!presented) {
      limiter.recordFailure(normalizedAddr);
      console.error(`[tandem] auth: rejected request from ${normalizedAddr} (no/bad token header)`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const storedToken = getToken();
    if (!storedToken) {
      limiter.recordFailure(normalizedAddr);
      console.error(`[tandem] auth: rejected request from ${normalizedAddr} (no server token)`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // SHA-256 both sides → timingSafeEqual (32-byte fixed-length digests eliminate length oracle)
    const presentedDigest = sha256(presented);

    function digestsMatch(candidate: string): boolean {
      const candidateDigest = sha256(candidate);
      try {
        return timingSafeEqual(candidateDigest, presentedDigest);
      } catch {
        // timingSafeEqual would only throw if lengths differ; since we SHA-256 both
        // to 32 bytes, this branch is unreachable but we fail-closed defensively.
        return false;
      }
    }

    // Primary: check current token
    let match = digestsMatch(storedToken);

    // Grace window: if primary fails, check whether the previous token is still valid
    if (!match) {
      const prev = getPreviousToken();
      if (prev) {
        match = digestsMatch(prev.value);
      }
    }

    if (!match) {
      limiter.recordFailure(normalizedAddr);
      // Do NOT log the presented or stored token — invariant 5
      console.error(`[tandem] auth: rejected request from ${normalizedAddr} (invalid token)`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    limiter.reset(normalizedAddr);
    next();
  };
}
