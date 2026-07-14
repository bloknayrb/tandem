/**
 * Fuzzy matching + ranking shared by the command palette (C1) and the
 * new-tab launcher (`src/client/tabs/newTabLauncher.ts`).
 *
 * Two-tier scorer: an exact substring match always outranks a subsequence
 * match (see `fuzzyMatch` for the score bound reasoning), and within each
 * tier earlier / word-boundary-aligned matches score higher. Pure and
 * side-effect free so it's unit-testable independent of the components.
 *
 * `toSegments` takes explicit match indices (rather than re-deriving a
 * substring range) so it composes with `fuzzyMatch`'s subsequence output.
 */

/** A single fuzzy-match result: overall score plus the matched target indices. */
export interface FuzzyMatchResult {
  score: number;
  indices: number[];
}

/** A run of matched/unmatched text for rendering highlighted spans. */
export interface MatchSegment {
  text: string;
  match: boolean;
}

/**
 * Only the subsequence tier (tier 2) truncates targets longer than this
 * before scanning (annotations can be long, and the char-by-char scan isn't
 * free). The substring tier (tier 1) always searches the FULL target — a
 * single `indexOf` over even a 10 KB string is cheap, and truncating it
 * would silently stop matching text past this offset (F7).
 */
const MAX_TARGET_LENGTH = 500;

const SUBSTRING_BASE_SCORE = 10000;
const SUBSTRING_START_BONUS = 500;
const SUBSTRING_BOUNDARY_BONUS = 250;

const SUBSEQUENCE_CONSECUTIVE_BONUS = 16;
const SUBSEQUENCE_BOUNDARY_BONUS = 8;
const SUBSEQUENCE_START_BONUS = 12;
const SUBSEQUENCE_GAP_PENALTY = 1;

/**
 * Hard ceiling on the tier-2 (subsequence) score. Combined with the tier-1
 * floor below, substring matches always outrank subsequence matches —
 * absolutely, not just for "realistic" queries (F8): a pathologically long,
 * heavily-bonused subsequence match can otherwise exceed a substring match
 * found deep in a long target.
 */
const SUBSEQUENCE_MAX_SCORE = 9000;

/**
 * True when `target[idx]` starts a "word" — either the very start of the
 * string, preceded by a non-alphanumeric character (space/punct), or a
 * lowercase→Uppercase camelCase transition. Computed on the original casing
 * (a lowercased string has no case transitions to find).
 */
function isWordBoundary(target: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = target[idx - 1];
  const curr = target[idx];
  if (!/[a-zA-Z0-9]/.test(prev)) return true;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  return false;
}

/**
 * Fuzzy-match `query` against `target`, case-insensitively.
 *
 * Two tiers, in priority order:
 * 1. Exact substring, searched over the FULL (untruncated) target — score =
 *    10000 − min(matchIndex, 499), +500 if the match starts at index 0, else
 *    +250 if it starts at a word boundary. The minimum possible substring
 *    score is 10000 − 499 + 0 = 9501 (deep matches floor out rather than
 *    going negative or unbounded).
 * 2. Subsequence — greedy scan over a target capped at `MAX_TARGET_LENGTH`
 *    chars, that prefers extending the current consecutive run (checks the
 *    very next target char before searching ahead): +16 per consecutive-run
 *    char, +8 per matched char that lands on a word boundary, +12 if the
 *    first matched char is at index 0, −1 per skipped ("gap") character
 *    between consecutive matches. The raw score is clamped to
 *    `SUBSEQUENCE_MAX_SCORE` (9000). Returns `null` if `query` is not a
 *    subsequence of `target`.
 *
 * With those bounds, 9501 > 9000 unconditionally: a substring match ALWAYS
 * outranks a subsequence match — this is an absolute guarantee, not one that
 * merely holds for realistic queries (F8). Two substring matches that are
 * both past index 499 tie at the score floor; ties fall back to the
 * palette's own original-index tiebreak.
 *
 * Highlight `indices` are positions in the target string. `target.toLowerCase()`
 * can change string length for some Unicode characters (e.g. "İ" → "i̇"),
 * which would shift every index relative to the original string. When that
 * happens (`indicesReliable` is false) both tiers return `indices: []`
 * instead of misaligned positions — `toSegments` then renders the row
 * unhighlighted; score/rank are unaffected. Tier 2's boundary lookups
 * (`isWordBoundary` on the truncated target) can also be slightly off in
 * that case, but that only perturbs the score, not user-visible indices.
 *
 * Returns `null` for an empty query (nothing to score) or when no match is
 * found.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (!query) return null;
  const lowerFull = target.toLowerCase();
  const indicesReliable = lowerFull.length === target.length;
  const q = query.toLowerCase();

  // Tier 1: exact substring, over the full target (F7 — no truncation here).
  const substringIdx = lowerFull.indexOf(q);
  if (substringIdx !== -1) {
    let score = SUBSTRING_BASE_SCORE - Math.min(substringIdx, MAX_TARGET_LENGTH - 1);
    if (substringIdx === 0) {
      score += SUBSTRING_START_BONUS;
    } else if (isWordBoundary(target, substringIdx)) {
      score += SUBSTRING_BOUNDARY_BONUS;
    }
    const indices: number[] = [];
    for (let i = 0; i < q.length; i++) indices.push(substringIdx + i);
    return { score, indices: indicesReliable ? indices : [] };
  }

  // Tier 2: greedy-with-lookahead subsequence scan, capped to MAX_TARGET_LENGTH.
  const truncated = target.length > MAX_TARGET_LENGTH ? target.slice(0, MAX_TARGET_LENGTH) : target;
  const lowerTarget = truncated.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let searchFrom = 0;
  let prevMatchIdx = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi];
    // Prefer continuing the current consecutive run before searching ahead.
    let foundIdx: number;
    if (searchFrom < lowerTarget.length && lowerTarget[searchFrom] === qc) {
      foundIdx = searchFrom;
    } else {
      foundIdx = lowerTarget.indexOf(qc, searchFrom);
    }
    if (foundIdx === -1) return null;

    if (prevMatchIdx !== -1) {
      if (foundIdx === prevMatchIdx + 1) {
        score += SUBSEQUENCE_CONSECUTIVE_BONUS;
      } else {
        score -= (foundIdx - prevMatchIdx - 1) * SUBSEQUENCE_GAP_PENALTY;
      }
    }
    if (isWordBoundary(truncated, foundIdx)) {
      score += SUBSEQUENCE_BOUNDARY_BONUS;
    }
    if (qi === 0 && foundIdx === 0) {
      score += SUBSEQUENCE_START_BONUS;
    }

    indices.push(foundIdx);
    prevMatchIdx = foundIdx;
    searchFrom = foundIdx + 1;
  }

  return { score: Math.min(score, SUBSEQUENCE_MAX_SCORE), indices: indicesReliable ? indices : [] };
}

/** A field-scoring result: overall weighted score plus the primary field's match indices. */
export interface FieldScore {
  score: number;
  indices: number[];
}

/**
 * Scores a candidate over a primary field plus optional secondary fields.
 * Secondary scores are weighted ×0.75; the returned indices are always the
 * primary field's (secondary-field indices don't map onto displayed text).
 * Falsy secondary fields (empty string, null, undefined) are skipped, same
 * as the ad-hoc `field ? fuzzyMatch(q, field) : null` guards this replaces.
 * Returns `null` when no field matches.
 */
export function scoreFields(
  query: string,
  primary: string,
  ...secondary: Array<string | null | undefined>
): FieldScore | null {
  const primaryMatch = fuzzyMatch(query, primary);
  const scores: number[] = [];
  if (primaryMatch) scores.push(primaryMatch.score);
  for (const field of secondary) {
    if (!field) continue;
    const match = fuzzyMatch(query, field);
    if (match) scores.push(match.score * 0.75);
  }
  if (scores.length === 0) return null;
  return { score: Math.max(...scores), indices: primaryMatch ? primaryMatch.indices : [] };
}

/**
 * Sort scored candidates descending by score and return the results.
 * The explicit `origIndex` tiebreak keeps equal-score candidates in their
 * original (input) order — JS sort is stable, but the tiebreak documents the
 * intent and survives a future non-stable-sort refactor. Sorts `scored` in
 * place (callers always build the array fresh per query).
 */
export function rankByScore<T>(
  scored: Array<{ result: T; score: number; origIndex: number }>,
): T[] {
  scored.sort((a, b) => b.score - a.score || a.origIndex - b.origIndex);
  return scored.map((s) => s.result);
}

/**
 * Split `target` into matched/unmatched runs given the (ascending or
 * unordered) match `indices` from `fuzzyMatch`. Consecutive matched indices
 * collapse into a single segment. Segments always reassemble to exactly
 * `target` (every character of `target` appears in exactly one segment).
 */
export function toSegments(target: string, indices: number[]): MatchSegment[] {
  if (target.length === 0) return [];
  const matchSet = new Set(indices);
  const segments: MatchSegment[] = [];
  let pos = 0;
  while (pos < target.length) {
    const isMatch = matchSet.has(pos);
    const start = pos;
    while (pos < target.length && matchSet.has(pos) === isMatch) pos++;
    segments.push({ text: target.slice(start, pos), match: isMatch });
  }
  return segments;
}
