import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localModelFetchForHarness,
  setLocalModelFetchForHarness,
} from "../../../src/server/local-model/ollama-client.js";
import { loopbackFetch } from "../../../src/shared/loopback-fetch.js";

/**
 * #1123 / #2422: the local-model client posts through `clientFetch`, which is
 * `loopbackFetch` unless the measurement harness has wrapped it (its fetch tap
 * and its fingerprint's scripted stub). The setter is a way around
 * `loopbackFetch`, so who may call it is pinned here: nothing in `src/`, and in
 * `probe/` only the two harness files that need it. Both wrap the `fetch` they
 * read and put it back.
 */
const ROOT = resolve(__dirname, "../../..");
const SETTER = /\bsetLocalModelFetchForHarness\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : walk(p);
    return /\.[cm]?[tj]s$/.test(p) ? [p] : [];
  });
}
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, "/");

afterEach(() => setLocalModelFetchForHarness(null));

describe("the local-model client's fetch seam (#1123, #2422)", () => {
  it("starts as loopbackFetch, and null puts loopbackFetch back", () => {
    expect(localModelFetchForHarness()).toBe(loopbackFetch);
    const wrapper = vi.fn(loopbackFetch);
    setLocalModelFetchForHarness(wrapper);
    expect(localModelFetchForHarness()).toBe(wrapper);
    setLocalModelFetchForHarness(null);
    expect(localModelFetchForHarness()).toBe(loopbackFetch);
  });

  it("nothing in src/ calls the setter; it is defined only in ollama-client.ts", () => {
    const users = walk(join(ROOT, "src"))
      .filter((f) => SETTER.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(users).toEqual(["src/server/local-model/ollama-client.ts"]);
  });

  it("in probe/, only the fetch tap and the fingerprint call it", () => {
    const users = walk(join(ROOT, "probe"))
      .filter((f) => SETTER.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual([
      "probe/local-model-spike/harness/fetch-tap.ts",
      "probe/local-model-spike/harness/fingerprint.ts",
    ]);
  });
});
