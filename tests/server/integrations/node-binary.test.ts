import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  _resetNodeBinaryCacheForTests,
  BARE_NODE,
  isRecordedPathGone,
  probeNodeBinary,
  resolveNodeBinary,
} from "../../../src/server/integrations/node-binary.js";
import { isValidNodeBinary } from "../../../src/shared/integrations/node-binary-name.js";

/**
 * The channel shim's `command`.
 *
 * A bare `"node"` was found failing in the field two ways, both silent: Node
 * absent from the MCP client's PATH, and Node resolving under the session's cwd
 * (Claude Code's anti-PATH-hijack guard). An absolute path fixes both — but it
 * must never be one the wizard's own re-read (`isValidNodeBinary`) rejects, or
 * Tandem reports its own correct config as invalid.
 */
describe("resolveNodeBinary", () => {
  it("returns an absolute path that the config validator accepts", () => {
    const resolved = resolveNodeBinary();
    expect(isAbsolute(resolved)).toBe(true);
    expect(isValidNodeBinary(resolved)).toBe(true);
  });

  it("falls back to the bare name rather than emitting an invalid path", () => {
    // A host running Tandem under something that isn't Node would otherwise
    // produce a path the validator rejects — strictly worse than the bare name,
    // because it would also fail the wizard's re-read.
    expect(resolveNodeBinary("/usr/bin/python")).toBe(BARE_NODE);
  });

  it("falls back on an empty candidate", () => {
    expect(resolveNodeBinary("")).toBe(BARE_NODE);
  });

  it("accepts the desktop app's bundled sidecar", () => {
    const sidecar = resolveNodeBinary("/Applications/Tandem.app/Contents/MacOS/node-sidecar");
    expect(isValidNodeBinary(sidecar)).toBe(true);
    expect(sidecar).not.toBe(BARE_NODE);
  });

  it("strips the Windows extended-length prefix off a drive path", () => {
    // `\\?\C:\...` starts with `\\`, which the validator rejects as UNC. Left
    // in place it would silently demote every Windows path to the bare name.
    const resolved = resolveNodeBinary("\\\\?\\C:\\Program Files\\nodejs\\node.exe");
    expect(resolved.startsWith("\\\\")).toBe(false);
    expect(isValidNodeBinary(resolved)).toBe(true);
  });

  it("does NOT strip the prefix off a UNC path", () => {
    // The load-bearing case. `\\?\UNC\server\share\node.exe` must keep its
    // leading `\\` so the NTLM-leak rejection still fires — a blind strip of
    // `\\?\` would turn a rejected UNC path into an accepted one.
    expect(resolveNodeBinary("\\\\?\\UNC\\server\\share\\node.exe")).toBe(BARE_NODE);
  });

  it("rejects a plain UNC path", () => {
    // Platform-independent by construction, and it has to be said out loud
    // because this assertion passed on Windows while failing on Linux CI.
    // `resolve()` preserves a leading `\\` on win32 but treats the same string
    // as a RELATIVE name on POSIX, prepending cwd and erasing the prefix the
    // NTLM-leak guard keys on — after which the basename (`node.exe`) validates
    // and a UNC path is emitted into the user's config. So the UNC question is
    // asked of the written path, before any normalization.
    expect(resolveNodeBinary("\\\\server\\share\\node.exe")).toBe(BARE_NODE);
  });

  it("rejects the forward-slash UNC spelling too", () => {
    // This one never broke — `//server/...` is absolute on both platforms, so
    // `resolve` left it alone and the guard fired. Pinned anyway: it is the
    // same rule, and a fix that only handled backslashes would look correct.
    expect(resolveNodeBinary("//server/share/node.exe")).toBe(BARE_NODE);
  });

  it("resolves the default candidate once, and warns once", () => {
    // One cause deserves one warning. `buildMcpEntries` resolves per entry and
    // three separate callers loop over every detected target, so an unmemoized
    // resolution printed the four-line fallback warning once per target per
    // operation — twice for `tandem setup --apply` on a box with Claude Code
    // plus Desktop, and again on every boot sweep. The value is process-
    // constant, so the repetition carried no information.
    const original = process.execPath;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A Python basename fails `isValidNodeBinary`, which is what routes this
    // through `fallBackToBareNode` — the only branch that logs.
    Object.defineProperty(process, "execPath", { value: "/usr/bin/python", configurable: true });
    _resetNodeBinaryCacheForTests();
    try {
      expect(resolveNodeBinary()).toBe(BARE_NODE);
      expect(resolveNodeBinary()).toBe(BARE_NODE);
      expect(resolveNodeBinary()).toBe(BARE_NODE);
      expect(spy).toHaveBeenCalledTimes(1);

      // An explicit candidate is the test seam and always recomputes — the
      // memo must not swallow a warning a caller asked for by name.
      expect(resolveNodeBinary("/usr/bin/ruby")).toBe(BARE_NODE);
      expect(resolveNodeBinary("/usr/bin/ruby")).toBe(BARE_NODE);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      Object.defineProperty(process, "execPath", { value: original, configurable: true });
      // Mandatory, not tidiness: the memo is keyed on "was this the default",
      // so leaving it set would serve `/usr/bin/python`'s BARE_NODE to every
      // later caller asking about the real execPath.
      _resetNodeBinaryCacheForTests();
      spy.mockRestore();
    }
  });
});

/**
 * The counterpart risk: an absolute path can outlive the binary it names (a
 * deleted nvm version, a Tauri update, macOS App Translocation, an AppImage
 * remount). Write-time validation cannot see that, so boot-time re-validation
 * is what keeps this a fix rather than a trade.
 */
describe("isRecordedPathGone", () => {
  const missing = () => false;
  const present = () => true;

  it("flags an absolute path that no longer exists", () => {
    expect(isRecordedPathGone("/home/u/.nvm/versions/node/v20/bin/node", missing)).toBe(true);
  });

  it("leaves an absolute path that still exists alone", () => {
    expect(isRecordedPathGone("/usr/local/bin/node", present)).toBe(false);
  });

  it("never flags a bare name", () => {
    // Whether `node` resolves is the client's lookup to perform at spawn time,
    // not ours to pre-judge — and rewriting it would undo a deliberate fallback.
    expect(isRecordedPathGone("node", missing)).toBe(false);
    expect(isRecordedPathGone("node.exe", missing)).toBe(false);
  });

  it("recognises a Windows path as absolute", () => {
    expect(isRecordedPathGone("C:\\Program Files\\nodejs\\node.exe", missing)).toBe(true);
    // Both flavours, on whichever host runs the suite. The value comes out of a
    // config file, not from this process, and CI reads Windows-shaped fixtures
    // on Linux — `path.isAbsolute` alone would call the above relative there.
    expect(isRecordedPathGone("\\\\server\\share\\node.exe", missing)).toBe(true);
    expect(isRecordedPathGone("/usr/local/bin/node", missing)).toBe(true);
  });

  it("never flags a RELATIVE path, however many separators it has", () => {
    // The guard used to be "contains a separator", which resolves these against
    // whatever cwd the caller happens to have — `tandem doctor` runs wherever
    // it was invoked, `/api/diagnostics` runs in the server's cwd — while the
    // path is really relative to the SPAWNING CLIENT's directory. A valid
    // project-local entry would be reported gone and, server-side, rewritten.
    expect(isRecordedPathGone("./node_modules/.bin/node", missing)).toBe(false);
    expect(isRecordedPathGone("bin/node", missing)).toBe(false);
    expect(isRecordedPathGone("..\\node\\node.exe", missing)).toBe(false);
  });

  it("treats an empty command as nothing to do", () => {
    expect(isRecordedPathGone("", missing)).toBe(false);
  });

  it("reports NOT stale when the probe could not determine anything", () => {
    // The inverted-polarity case. Here a `false` makes the caller rewrite the
    // user's `~/.claude.json`, so an unreadable path (EACCES, ELOOP, a
    // disconnected share) must not be mistaken for an absent one.
    expect(isRecordedPathGone("/unreadable/bin/node", () => null)).toBe(false);
  });
});

describe("probeNodeBinary", () => {
  it("returns false for a path that is definitely absent", () => {
    expect(probeNodeBinary(join(tmpdir(), "tandem-definitely-not-here-9e3f1a"))).toBe(false);
  });

  it("returns false for a directory", () => {
    // Not `null` — a directory is a determinate answer, and a determinate
    // "not a binary" is what licenses the repair.
    expect(probeNodeBinary(tmpdir())).toBe(false);
  });

  it("returns true for a real file", () => {
    expect(probeNodeBinary(process.execPath)).toBe(true);
  });
});
