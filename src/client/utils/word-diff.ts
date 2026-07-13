/**
 * Word-level diff for suggestion cards (B1). Whole-text strike-through +
 * whole-text insert (the legacy `SuggestionCard.svelte` rendering) is
 * unreadable for one-word edits inside a long sentence — this computes a
 * token-level LCS diff so only the changed words are highlighted.
 *
 * Tokenization splits on whitespace RUNS but keeps them as their own tokens
 * (`str.split(/(\s+)/).filter(Boolean)`), so whitespace-only edits (e.g. a
 * collapsed double space, or a changed line break) are diffable too, and
 * newlines survive as ordinary tokens.
 *
 * Standard O(m*n) LCS dynamic programming over tokens, then backtrack to
 * segments and merge adjacent same-type runs. Callers MUST treat a `null`
 * return as "fall back to the legacy whole-text rendering" — the DP table is
 * quadratic, so pathologically large inputs are rejected before they're
 * built (see `diffWords` for the exact caps).
 */
export type DiffSegment = { type: "equal" | "del" | "ins"; text: string };

/** Words AND whitespace runs, in order. Preserves newlines/spacing exactly. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter(Boolean);
}

const MAX_TOKEN_PRODUCT = 40_000;
const MAX_COMBINED_LENGTH = 6_000;

/**
 * Returns a list of diff segments turning `oldText` into `newText`, or
 * `null` if the input exceeds the size caps (caller should fall back to
 * legacy whole-text rendering in that case).
 */
export function diffWords(oldText: string, newText: string): DiffSegment[] | null {
  if (oldText.length + newText.length > MAX_COMBINED_LENGTH) return null;

  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  if (oldTokens.length * newTokens.length > MAX_TOKEN_PRODUCT) return null;

  const m = oldTokens.length;
  const n = newTokens.length;

  // dp[i][j] = length of the LCS of oldTokens[0..i) and newTokens[0..j)
  const dp: Uint32Array[] = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack from (m, n) to (0, 0), building ops in reverse.
  type Op = { type: "equal" | "del" | "ins"; text: string };
  const reversedOps: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      reversedOps.push({ type: "equal", text: oldTokens[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      // Strict `>` (not `>=`) is the tie-break that makes substitutions
      // render del-before-ins (old -> new), matching jsdiff/GitHub convention
      // and the legacy `~~old~~ -> new` fallback. Ops are pushed walking
      // backward from the end of both strings and reversed below, so the op
      // pushed LATER here lands EARLIER in the output; on a tie, taking the
      // `ins` branch first means `del` ends up before `ins` after reversal.
      // `>=` inverts this and renders "new ~~old~~" instead.
      reversedOps.push({ type: "del", text: oldTokens[i - 1] });
      i--;
    } else {
      reversedOps.push({ type: "ins", text: newTokens[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    reversedOps.push({ type: "del", text: oldTokens[i - 1] });
    i--;
  }
  while (j > 0) {
    reversedOps.push({ type: "ins", text: newTokens[j - 1] });
    j--;
  }
  reversedOps.reverse();

  // Merge adjacent same-type ops into segments.
  const segments: DiffSegment[] = [];
  for (const op of reversedOps) {
    const last = segments[segments.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      segments.push({ type: op.type, text: op.text });
    }
  }
  return segments;
}
