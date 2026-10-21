import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Drift guard: no doc may say `tandem rotate-token` replaces, retires or
 * regenerates "the" token without scoping that claim to the npm install's
 * token file.
 *
 * `src/cli/rotate-token.ts` rewrites exactly one thing: the `auth-token` file
 * at the npm install's location (`getTokenFilePath`). It never touches the
 * desktop app's token, which lives in the OS keychain, and it refuses to run
 * at all when the token arrives through the environment (as it does for the
 * desktop sidecar). An unscoped "rotate-token replaces it" reads as a way to
 * retire a leaked desktop token, and it is not: the glossary said exactly
 * that until PR #2248's review, and `docs/data-locations.md` relies on the
 * opposite ("`tandem rotate-token` does not reach it, so removing the entries
 * is the way to retire it").
 *
 * **Sentence-scoped**, because a file-scoped check would be satisfied by one
 * correct sentence anywhere while a wrong one sat beside it. A sentence that
 * names `rotate-token` and then claims a replacement must, after the command
 * in that same sentence, either say it only covers the npm install's file or
 * say it does not reach (the keychain). Sentences that only mention the
 * command (the grace window, the loopback rule) make no claim and pass.
 *
 * The positive control proves the matcher still catches the original wording,
 * and the presence check proves the scan is not vacuous: if every sentence
 * naming `rotate-token` disappeared, or the splitter broke, this would
 * otherwise pass by finding nothing.
 */

const ROOT = path.resolve(__dirname, "../..");

const CLAIM_FILES = [
  "docs/glossary.md",
  "docs/configuration.md",
  "docs/data-locations.md",
  "docs/security.md",
] as const;

const COMMAND = /rotate-token/;

/** A claim that the command swaps out or disposes of a token. */
const REPLACES =
  /\b(replac\w*|retir\w*|revok\w*|regenerat\w*|(?:generat|mint)\w*\s+a\s+(?:new|fresh))\b/i;

/**
 * Scoping that makes the claim true: npm-file-only, an explicit keychain
 * negative, or "does not reach". Tested only on the text AFTER the command,
 * so "the keychain, the npm install in a file, and rotate-token replaces it"
 * cannot borrow scope from a clause about something else.
 */
const SCOPED =
  /\bnpm\b|(?:not|never|n't)\b[^.]*\bkeychain\b|\bkeychain\b[^.]*\b(?:not|never|n't)\b|\b(?:not|never|n't)\s+reach/i;

/** Paragraph text with fenced blocks removed and line wraps joined. */
function sentences(markdown: string): string[] {
  return markdown
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "")
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.|\|)\s)/)
    .map((para) => para.replace(/\s*\n\s*/g, " "))
    .flatMap((para) => para.split(/(?<=[.!?])\s+(?=[A-Z*`[(])/));
}

/** The sentence from the command onwards, or null if it never names it. */
function afterCommand(sentence: string): string | null {
  const at = sentence.search(COMMAND);
  return at === -1 ? null : sentence.slice(at);
}

/**
 * Does the sentence name the command and then claim a replacement? The verb
 * must follow the command, so "deleting it makes Tandem mint a new one — run
 * `tandem rotate-token` instead" (about deleting the file) is not a claim.
 */
function claimsReplacement(sentence: string): boolean {
  const tail = afterCommand(sentence);
  return tail !== null && REPLACES.test(tail);
}

/** Sentences that claim a replacement without saying what it does not cover. */
function unscopedClaims(markdown: string): string[] {
  return sentences(markdown).filter(
    (s) => claimsReplacement(s) && !SCOPED.test(afterCommand(s) ?? ""),
  );
}

describe("rotate-token scope claims", () => {
  it("catches the unscoped wording (positive control)", () => {
    // The glossary's pre-#2248 sentence, wrapped as it was in the file.
    const original =
      "The desktop app keeps it in the OS keychain, the npm\ninstall in a file, and " +
      "`tandem rotate-token` replaces it. See the docs.";
    expect(unscopedClaims(original)).toHaveLength(1);
    expect(unscopedClaims("Run `tandem rotate-token` to retire the token.")).toHaveLength(1);
    expect(
      unscopedClaims("`tandem rotate-token` generates a new token and updates configs."),
    ).toHaveLength(1);
  });

  it("accepts a scoped claim", () => {
    expect(
      unscopedClaims(
        "`tandem rotate-token` replaces the npm install's token file only; it does not\n" +
          "reach the desktop app's keychain token.",
      ),
    ).toEqual([]);
    expect(
      unscopedClaims("The keychain, where `tandem rotate-token` does not reach it, is retired."),
    ).toEqual([]);
  });

  it.each(CLAIM_FILES)("%s scopes every rotate-token replacement claim", (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf-8");
    expect(unscopedClaims(text)).toEqual([]);
  });

  it("finds rotate-token sentences to check (the scan is not vacuous)", () => {
    const claims = CLAIM_FILES.flatMap((file) =>
      sentences(readFileSync(path.join(ROOT, file), "utf-8")).filter(claimsReplacement),
    );
    // The glossary, configuration and security entries each make one.
    expect(claims.length).toBeGreaterThanOrEqual(3);
  });
});
