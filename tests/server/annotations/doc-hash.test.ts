import * as crypto from "node:crypto";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { docHash } from "../../../src/server/annotations/doc-hash.js";
import { isUploadPath } from "../../../src/shared/paths.js";

const HEX_64_RE = /^[0-9a-f]{64}$/;
const IS_WINDOWS = process.platform === "win32";

describe("docHash", () => {
  it("is deterministic: same path → same hash", () => {
    const p = IS_WINDOWS ? "C:/Users/me/notes.md" : "/home/me/notes.md";
    expect(docHash(p)).toBe(docHash(p));
  });

  it("distinguishes different paths", () => {
    const a = IS_WINDOWS ? "C:/Users/me/a.md" : "/home/me/a.md";
    const b = IS_WINDOWS ? "C:/Users/me/b.md" : "/home/me/b.md";
    expect(docHash(a)).not.toBe(docHash(b));
  });

  it("returns a 64-char lowercase hex string for real paths", () => {
    const h = docHash(IS_WINDOWS ? "C:/tmp/x.md" : "/tmp/x.md");
    expect(h).toMatch(HEX_64_RE);
    expect(h).toHaveLength(64);
  });

  it.runIf(IS_WINDOWS)(
    "treats Windows paths as case-insensitive and normalizes separators/trailing slashes",
    () => {
      // NTFS is case-insensitive and accepts mixed separators; all of these
      // must collapse to the same hash.
      const variants = ["C:\\foo\\bar.md", "c:/Foo/bar.md", "C:/foo/bar.md", "C:/FOO/BAR.MD"];
      const hashes = variants.map(docHash);
      for (const h of hashes) expect(h).toBe(hashes[0]);
    },
  );

  it.skipIf(IS_WINDOWS)(
    "treats POSIX paths as case-sensitive (different case → different hash)",
    () => {
      expect(docHash("/home/me/Foo.md")).not.toBe(docHash("/home/me/foo.md"));
    },
  );

  it("resolves relative paths to absolute before hashing", () => {
    // A relative path and its path.resolve'd absolute form should hash
    // identically — this guards against callers passing relative paths.
    const rel = "foo/bar.md";
    const abs = path.resolve(rel);
    expect(docHash(rel)).toBe(docHash(abs));
  });

  it("maps upload://<id>/<name> to upload_<id>", () => {
    expect(docHash("upload://abc123/foo.md")).toBe("upload_abc123");
  });

  it("ignores the filename portion of upload paths (rename-stable)", () => {
    expect(docHash("upload://abc123/foo.md")).toBe(docHash("upload://abc123/bar.txt"));
  });

  it("distinguishes different upload ids", () => {
    expect(docHash("upload://abc123/x.md")).not.toBe(docHash("upload://def456/x.md"));
  });

  it("falls back to SHA-256 for malformed upload paths (no id/name split)", () => {
    // `upload://` has no id — not `upload_<something>`. Should hash the
    // literal string instead so the result is still a deterministic 64-hex
    // key that can't collide with the well-formed `upload_<id>` namespace.
    const h = docHash("upload://");
    expect(h).not.toMatch(/^upload_/);
    expect(h).toMatch(HEX_64_RE);
    // And it must equal the raw SHA-256 of the literal string (the spec's
    // stated fallback behavior).
    const expected = crypto.createHash("sha256").update("upload://").digest("hex");
    expect(h).toBe(expected);
  });

  it("produces no sha256: prefix (filename-safe raw hex)", () => {
    const h = docHash(IS_WINDOWS ? "C:/tmp/x.md" : "/tmp/x.md");
    expect(h.startsWith("sha256:")).toBe(false);
  });
});

describe("isUploadPath", () => {
  it("returns true for upload:// paths", () => {
    expect(isUploadPath("upload://abc123/foo.md")).toBe(true);
    expect(isUploadPath("upload://")).toBe(true);
  });

  it("returns false for real filesystem paths", () => {
    expect(isUploadPath("/tmp/foo.md")).toBe(false);
    expect(isUploadPath("C:/Users/me/foo.md")).toBe(false);
    expect(isUploadPath("foo.md")).toBe(false);
    expect(isUploadPath("")).toBe(false);
  });
});
