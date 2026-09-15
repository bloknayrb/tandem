import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, rustSources } from "./rust-sources.js";

/**
 * The cross-language Cowork lock (#1600) excludes in BOTH directions only when
 * the desktop app is new enough. The npm scrub's share-mode-0 open makes Rust's
 * lockfile `open` fail with sharing violation 32. Only a `with_locked_json` that
 * opens INSIDE its backoff loop and treats 32 as contention waits that out. A
 * desktop build from before #1600 hard-fails instead, and the npm CLI and the
 * desktop app ship separately.
 *
 * That version-skew residual is a documented bound, not something code can
 * close from Node. These tests pin the two halves together:
 * - the prose that names the bound (security register + `rewriteJson` docblock);
 * - the Rust behaviour the bound's "newer builds are fine" half rests on.
 */

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("Cowork lock version-skew residual (#1600)", () => {
  it("docs/security.md's #1600 entry names the version-skew residual", () => {
    const doc = read("docs/security.md");
    const entry = doc.split("\n").find((l) => l.includes("**What is NOT accepted here.**"));
    expect(entry, "the #1600 'What is NOT accepted here' entry is missing").toBeDefined();
    expect(entry).toContain("issues/1600");
    expect(entry).toMatch(/version skew/i);
    expect(entry).toContain("v0.25.0 and earlier");
    expect(entry).toContain("partial registration");
  });

  it("rewriteJson's docblock bounds the two-way exclusion by desktop version", () => {
    const src = read("src/cli/uninstall-scrub.ts");
    const fnAt = src.indexOf("export async function rewriteJson(");
    expect(fnAt, "rewriteJson not found").toBeGreaterThan(-1);
    const docStart = src.lastIndexOf("/**", fnAt);
    const docblock = src.slice(docStart, fnAt);
    expect(docblock).toMatch(/Version skew/);
    expect(docblock).toContain("v0.25.0 and earlier");
  });

  it("with_locked_json opens the lockfile inside the backoff loop and retries 32", () => {
    const file = rustSources().find((s) => s.rel === "src-tauri/src/cowork_atomic_json.rs");
    expect(file, "positive control: cowork_atomic_json.rs must be in the walk").toBeDefined();
    const code = file?.code ?? "";

    const fnAt = code.indexOf("pub fn with_locked_json");
    expect(fnAt).toBeGreaterThan(-1);
    const body = code.slice(fnAt, code.indexOf("\nfn ", fnAt));
    const loopAt = body.indexOf("loop {");
    const openAt = body.indexOf("open_lockfile(&lock_path)");
    expect(loopAt, "backoff loop not found").toBeGreaterThan(-1);
    expect(openAt, "the lockfile open must be inside the loop, not before it").toBeGreaterThan(
      loopAt,
    );

    const contention = code.slice(code.indexOf("fn is_lock_contention"));
    expect(contention).toMatch(/Some\(32\)/);
  });
});
