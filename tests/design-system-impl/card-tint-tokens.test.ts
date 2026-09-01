import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCardTint } from "../../src/client/panels/annotation-card-helpers";
import type { Annotation } from "../../src/shared/types";

/**
 * Every token `getCardTint` can return must actually be declared.
 *
 * `annotation-card-helpers.test.ts` pins the author -> token-NAME map, and
 * `token-contrast.spec.ts` sweeps the tinted surfaces for contrast. Neither
 * catches a token that does not exist, and the gap is not theoretical:
 *
 *  - the unit test compares strings, so it is happy with a name nothing defines;
 *  - the contrast sweep resolves each token off `:root` and its `add()` helper
 *    bails silently when either side is null ("token not defined in this theme
 *    — not a failure"), so an ABSENT token is indistinguishable from a swept
 *    one, which is precisely the property that entry was added to provide;
 *  - no E2E renders an imported card at all — that needs a `.docx` import.
 *
 * So `--tandem-author-import-bg` could be deleted from index.html outright and
 * the entire suite stays green while every imported Word comment renders with
 * no background. This closes that, cheaply, without a browser.
 *
 * Deliberately a TEXT check against `index.html` rather than a computed-style
 * check: this is asking whether the declaration exists, and the two CSS
 * pipelines mean `index.html`'s inline `<style>` is emitted verbatim, so its
 * text is the shipped truth.
 */

const INDEX_HTML = readFileSync(join(import.meta.dirname, "..", "..", "index.html"), "utf-8");

const AUTHORS: Record<Annotation["author"], true> = { user: true, claude: true, import: true };

describe("card tint tokens are declared", () => {
  it.each(
    Object.keys(AUTHORS) as Annotation["author"][],
  )("%s's tint token exists in index.html", (author) => {
    const token = getCardTint(author);
    const name = /^var\((--[a-z0-9-]+)\)$/.exec(token)?.[1];
    expect(
      name,
      `getCardTint("${author}") returned ${token}, which is not a bare var()`,
    ).toBeTruthy();
    // A DECLARATION (`--x:`), not merely a mention — a token that only ever
    // appears inside some other rule's `var(--x)` is exactly the broken case.
    expect(
      INDEX_HTML.includes(`${name}:`),
      `${name} is never declared in index.html, so a ${author} card renders with no background`,
    ).toBe(true);
  });
});
