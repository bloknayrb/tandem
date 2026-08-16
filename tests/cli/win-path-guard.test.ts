import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeWorkspacePath } from "../../src/cli/win-path-guard.js";

/**
 * #1417 §1C. The guard's UNC check used to live only at step (c), testing the
 * *output* of `realpath` — so a literal `\\server\share\x` was `lstat`ed and
 * `realpath`ed first, and on Windows each of those performs the SMB handshake
 * that leaks an NTLM hash to the named host. The check meant to prevent the
 * handshake ran after it.
 *
 * **These assert on the SYSCALL, not the return value, and that distinction is
 * the entire test.** `assertSafeWorkspacePath` returns `null` for a UNC path
 * either way — before the fix because `realpath` threw on an unreachable host,
 * after it because step (a0) rejected the string. A `toBeNull()` assertion
 * passes against the vulnerable code and proves nothing. What changed is that
 * no filesystem call happens at all.
 */
describe("assertSafeWorkspacePath — UNC is rejected before any syscall (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["classic UNC", "\\\\attacker\\share\\ws\\vm"],
    ["forward-slash UNC", "//attacker/share/ws/vm"],
    ["extended UNC", "\\\\?\\UNC\\attacker\\share\\ws"],
    ["forward-slash extended UNC", "//?/UNC/attacker/share/ws"],
    // The three the old enumerate-the-bad-forms check let through. Windows
    // prefixes are case-insensitive, so a literal `UNC` comparison was a
    // one-character bypass; `GLOBALROOT\Device\Mup` and the `\\.\` device
    // namespace are two more routes to the same SMB handshake.
    ["lowercase extended UNC", "\\\\?\\unc\\attacker\\share\\ws"],
    ["mixed-case extended UNC", "\\\\?\\Unc\\attacker\\share\\ws"],
    ["GLOBALROOT via Mup", "\\\\?\\GLOBALROOT\\Device\\Mup\\attacker\\share"],
    ["device namespace", "\\\\.\\UNC\\attacker\\share\\ws"],
    ["device namespace, forward slash", "//./unc/attacker/share/ws"],
  ])("%s: refuses %s without calling lstat or realpath", async (_label, candidate) => {
    const lstat = vi.spyOn(fsp, "lstat");
    const realpath = vi.spyOn(fsp, "realpath");

    await expect(assertSafeWorkspacePath(candidate, os.tmpdir())).resolves.toBeNull();

    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it("still permits the extended-length LOCAL prefix it deliberately allows", async () => {
    // `\\?\C:\…` is NOT network. This guard permits it on purpose — Tauri's
    // path APIs hand it back, and containment under %LOCALAPPDATA% is what
    // confines it. Sharing the stricter shared predicate here would reject
    // legitimate local paths, so (a0) reuses this file's own `isUncPath`.
    // It must therefore reach the filesystem rather than being refused outright.
    const lstat = vi.spyOn(fsp, "lstat");
    await assertSafeWorkspacePath("\\\\?\\C:\\Users\\someone\\AppData\\Local\\x", os.tmpdir());
    // It IS still rejected — the fixture path does not exist, so the step (a)
    // walk fails closed before `realpath`. The point is *where*: reaching the
    // lstat walk at all proves (a0) passed it through rather than refusing the
    // prefix outright, which is the behaviour a shared-predicate "cleanup"
    // would silently break.
    expect(lstat).toHaveBeenCalled();
  });

  it.each([
    ["lowercase drive", "\\\\?\\c:\\Users\\someone\\x"],
    ["forward-slash form", "//?/C:/Users/someone/x"],
  ])("the local-extended allowlist is not narrower than the old check: %s", async (_label, candidate) => {
    // The allowlist rewrite must not shrink what (a0) permits. These two
    // shapes are what Windows and Node actually produce; refusing them here
    // would break real Tauri paths in the name of a security fix.
    const lstat = vi.spyOn(fsp, "lstat");
    await assertSafeWorkspacePath(candidate, os.tmpdir());
    expect(lstat).toHaveBeenCalled();
  });

  it("walks ancestors shallowest-first", async () => {
    // Ascending touched the deepest component first — the one carrying the
    // attacker's server name in a UNC path. Descending meets the root first,
    // and also catches a symlinked PARENT before touching its children.
    const seen: string[] = [];
    const lstat = vi.spyOn(fsp, "lstat").mockImplementation(async (p) => {
      seen.push(String(p));
      return { isSymbolicLink: () => false } as unknown as Awaited<ReturnType<typeof fsp.lstat>>;
    });
    vi.spyOn(fsp, "realpath").mockRejectedValue(new Error("stop after the walk"));

    const deep = path.resolve(os.tmpdir(), "a", "b", "c");
    await assertSafeWorkspacePath(deep, os.tmpdir());

    expect(lstat).toHaveBeenCalled();
    // First inspected must be an ancestor of the last, never the reverse.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(deep);
    expect(deep.startsWith(seen[0])).toBe(true);
  });
});
