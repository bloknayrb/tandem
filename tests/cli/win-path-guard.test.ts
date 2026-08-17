import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeWorkspacePath } from "../../src/cli/win-path-guard.js";
import { LOCAL_EXTENDED_PATHS, NETWORK_PATHS } from "../helpers/unc-fixtures.js";

/**
 * #1417 §1C. The guard's UNC check used to live only at step (c), testing the
 * *output* of `realpath` — so a literal `\\server\share\x` was `lstat`ed and
 * `realpath`ed first, and on Windows each of those performs the SMB handshake
 * that leaks an NTLM hash to the named host. The check meant to prevent the
 * handshake ran after it.
 *
 * Asserts the syscall, not the return value — see `tests/helpers/unc-fixtures.ts`
 * for why. Here the return value is `null` either way: before the fix because
 * `realpath` threw on an unreachable host, after it because step (a0) rejected
 * the string.
 */
describe("assertSafeWorkspacePath — UNC is rejected before any syscall (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(
    NETWORK_PATHS,
  )("%s: refuses %s without calling lstat or realpath", async (_label, candidate) => {
    const lstat = vi.spyOn(fsp, "lstat");
    const realpath = vi.spyOn(fsp, "realpath");

    await expect(assertSafeWorkspacePath(candidate, os.tmpdir())).resolves.toBeNull();

    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each(
    LOCAL_EXTENDED_PATHS,
  )("still permits the extended-length LOCAL prefix it deliberately allows: %s", async (_label, candidate) => {
    // `\?\C:\…` is NOT network. This guard permits it on purpose — Tauri's
    // path APIs hand it back, and containment under %LOCALAPPDATA% is what
    // confines it. Sharing the stricter shared predicate here would reject
    // legitimate local paths, so (a0) reuses this file's own `isUncPath`.
    //
    // These paths ARE still rejected — the fixtures do not exist, so the step
    // (a) walk fails closed before `realpath`. The point is *where*: reaching
    // the lstat walk at all proves (a0) passed them through rather than
    // refusing the prefix outright, which is what a shared-predicate
    // "cleanup" — or a narrower allowlist — would silently break.
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
