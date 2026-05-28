import { describe, expect, it } from "vitest";
import { rejectUnsafeWindowsPrefix } from "../../src/server/file-io/windows-path-safety.js";

describe("rejectUnsafeWindowsPrefix", () => {
  // Bare UNC.
  it("rejects bare backslash UNC", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\server\\share\\file.txt")).toMatch(/UNC/);
  });

  it("rejects bare forward-slash UNC", () => {
    expect(rejectUnsafeWindowsPrefix("//server/share/file.txt")).toMatch(/UNC/);
  });

  // Extended-length \\?\ — the bypass that bare-`\\` rejection missed.
  it("rejects \\\\?\\ extended-length prefix", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\?\\C:\\Users\\foo\\file.txt")).toMatch(/Extended/);
  });

  it("rejects \\\\?\\UNC\\ extended UNC", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\?\\UNC\\server\\share\\file.txt")).toMatch(/Extended/);
  });

  it("rejects forward-slash extended-length //?/", () => {
    expect(rejectUnsafeWindowsPrefix("//?/C:/Users/foo/file.txt")).toMatch(/Extended/);
  });

  // Mixed case — Windows is case-insensitive on path prefixes.
  it("rejects mixed-case \\\\?\\Unc\\", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\?\\Unc\\server\\share\\file.txt")).toMatch(/Extended/);
  });

  it("rejects upper-case \\\\?\\UNC\\", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\?\\UNC\\evil\\share\\loot")).toMatch(/Extended/);
  });

  // Device namespace \\.\
  it("rejects device namespace \\\\.\\NUL", () => {
    expect(rejectUnsafeWindowsPrefix("\\\\.\\NUL")).toMatch(/Extended/);
  });

  it("rejects device namespace forward-slash //./", () => {
    expect(rejectUnsafeWindowsPrefix("//./NUL")).toMatch(/Extended/);
  });

  // Safe paths.
  it("accepts a POSIX absolute path", () => {
    expect(rejectUnsafeWindowsPrefix("/home/user/file.txt")).toBeNull();
  });

  it("accepts a Windows drive-letter absolute path", () => {
    expect(rejectUnsafeWindowsPrefix("C:\\Users\\foo\\file.txt")).toBeNull();
  });

  it("accepts a Windows drive-letter forward-slash path", () => {
    expect(rejectUnsafeWindowsPrefix("C:/Users/foo/file.txt")).toBeNull();
  });

  it("accepts a relative path (refinement is upstream)", () => {
    // This helper only filters Windows-prefix attacks; absolute-path enforcement
    // is the caller's responsibility (e.g. Zod refine on the schema).
    expect(rejectUnsafeWindowsPrefix("subdir/file.txt")).toBeNull();
  });

  it("accepts an empty string (caller validates non-empty separately)", () => {
    expect(rejectUnsafeWindowsPrefix("")).toBeNull();
  });
});
