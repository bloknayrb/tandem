/**
 * The client reads an annotation's identity from its Y.Map KEY (`atMapKey`),
 * never from the stored `value.id`.
 *
 * A card's id is what every user action posts (reply, edit, promote,
 * resolve). When a record sat under key K with a stale `id: X`, the card
 * posted X: a reply typed in a NOTE card was then stamped against the comment
 * at X, written non-private, and read by Claude (ADR-027). Mounting the sync
 * hook needs live Hocuspocus providers, so the three map readers are pinned
 * from source, as the repo's other seam censuses are.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atMapKey } from "../../src/shared/sanitize";

const READERS = [
  "src/client/hooks/yjsSync.svelte.ts",
  "src/client/editor/extensions/annotation.ts",
  "src/client/hooks/useThreadAnswers.svelte.ts",
] as const;

function source(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("client annotation readers key records by their map key", () => {
  it.each(READERS)("%s iterates the annotations map with its key", (rel) => {
    const src = source(rel);
    expect(src).toMatch(/annotationsMap\.forEach\(\(value, key\) =>/);
    expect(src).not.toMatch(/annotationsMap\.forEach\(\(value\) =>/);
  });

  it("the card and decoration builders stamp the key with atMapKey", () => {
    expect(source("src/client/hooks/yjsSync.svelte.ts")).toMatch(/atMapKey\(\s*key,/);
    expect(source("src/client/editor/extensions/annotation.ts")).toMatch(/atMapKey\(\s*key,/);
  });

  it("thread-answer parents are indexed by key", () => {
    expect(source("src/client/hooks/useThreadAnswers.svelte.ts")).toMatch(/parents\.set\(key,/);
  });
});

describe("atMapKey", () => {
  it("returns the same reference when the stored id already is the key", () => {
    const rec = { id: "K", content: "x" };
    expect(atMapKey("K", rec)).toBe(rec);
  });

  it("returns a copy carrying the key when the stored id differs, leaving the input untouched", () => {
    const rec = { id: "X", content: "x" };
    const stamped = atMapKey("K", rec);
    expect(stamped).toEqual({ id: "K", content: "x" });
    expect(rec.id).toBe("X");
  });
});
