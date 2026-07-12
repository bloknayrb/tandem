/**
 * Fuzzy matching + ranking for the command palette (C1).
 *
 * Two-tier scorer: an exact substring match always outranks a subsequence
 * match (see `fuzzyMatch` for the score bound reasoning), and within each
 * tier earlier / word-boundary-aligned matches score higher. Pure and
 * side-effect free so it's unit-testable independent of `CommandPalette.svelte`.
 *
 * `toSegments` mirrors `highlightSegments` in `src/client/tabs/newTabLauncher.ts`
 * but takes explicit match indices (rather than re-deriving a substring range)
 * so it composes with `fuzzyMatch`'s subsequence output.
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

/** Targets longer than this are truncated before matching (annotations can be long). */
const MAX_TARGET_LENGTH = 500;

const SUBSTRING_BASE_SCORE = 10000;
const SUBSTRING_START_BONUS = 500;
const SUBSTRING_BOUNDARY_BONUS = 250;

const SUBSEQUENCE_CONSECUTIVE_BONUS = 16;
const SUBSEQUENCE_BOUNDARY_BONUS = 8;
const SUBSEQUENCE_START_BONUS = 12;
const SUBSEQUENCE_GAP_PENALTY = 1;

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
 * 1. Exact substring — score = 10000 − matchIndex, +500 if the match starts
 *    at index 0, else +250 if it starts at a word boundary. The minimum
 *    substring score (10000 − 499, over the 500-char target cap) stays above
 *    the realistic maximum subsequence score for normal (short/medium)
 *    queries, so any substring match outranks any subsequence match.
 * 2. Subsequence — greedy scan that prefers extending the current
 *    consecutive run (checks the very next target char before searching
 *    ahead): +16 per consecutive-run char, +8 per matched char that lands on
 *    a word boundary, +12 if the first matched char is at index 0, −1 per
 *    skipped ("gap") character between consecutive matches. Returns `null`
 *    if `query` is not a subsequence of `target`.
 *
 * Returns `null` for an empty query (nothing to score) or when no match is
 * found.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (!query) return null;
  const truncated = target.length > MAX_TARGET_LENGTH ? target.slice(0, MAX_TARGET_LENGTH) : target;
  const q = query.toLowerCase();
  const lowerTarget = truncated.toLowerCase();

  // Tier 1: exact substring.
  const substringIdx = lowerTarget.indexOf(q);
  if (substringIdx !== -1) {
    let score = SUBSTRING_BASE_SCORE - substringIdx;
    if (substringIdx === 0) {
      score += SUBSTRING_START_BONUS;
    } else if (isWordBoundary(truncated, substringIdx)) {
      score += SUBSTRING_BOUNDARY_BONUS;
    }
    const indices: number[] = [];
    for (let i = 0; i < q.length; i++) indices.push(substringIdx + i);
    return { score, indices };
  }

  // Tier 2: greedy-with-lookahead subsequence scan.
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

  return { score, indices };
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
