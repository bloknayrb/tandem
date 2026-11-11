/**
 * Fixtures for the Windows 8.3 short-name tests (#2400).
 *
 * The product's expansion runs only on `win32`, so on any other host it is
 * exercised through `_setShortNameDepsForTests`. To keep every REAL filesystem
 * call in the open pipeline working on every host, the alias here is a hard
 * link: `ALIASX~7.MD` and `a long file name.md` are one file, `realpathSync`
 * keeps whichever name it was given (as Node's JS realpath keeps an 8.3 alias
 * on Windows), and `lstat` reports one inode for both. Only the native realpath
 * is faked, because only Windows has one that expands the name.
 *
 * Nothing here depends on the host's `process.platform`, path separator or
 * case-folding: the two names differ by more than case, and paths are built
 * with the host's own `path`.
 *
 * A hard link can only alias a FILE. A short FOLDER component (the case #2400
 * measured) needs a real Windows volume and lives in
 * `tests/server/short-name-documents.win.test.ts`.
 */

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import * as Y from "yjs";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import { closeStore, quiesceForTesting } from "../../src/server/annotations/store.js";
import { resetForTesting as syncReset } from "../../src/server/annotations/sync.js";
import { resetForTesting as dirtyReset } from "../../src/server/documents/dirty.js";
import { removeDoc } from "../../src/server/documents/registry-testing.js";
import { _resetShortNameAdoptionForTests } from "../../src/server/documents/short-name-adoption.js";
import { clearFileSyncContext } from "../../src/server/events/queue.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { _setShortNameDepsForTests } from "../../src/server/file-io/short-names.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { removeDocument } from "../../src/server/yjs/provider.js";
import { withInternal } from "../../src/shared/origins.js";

export const LONG_NAME = "a long file name.md";
export const ALIAS_NAME = "ALIASX~7.MD";

export interface AliasFixture {
  dir: string;
  /** The file under its long name. */
  longPath: string;
  /** The same file under its 8.3-shaped alias. */
  aliasPath: string;
  cleanup(): Promise<void>;
}

/** One markdown file reachable under a long name and an alias-shaped one. */
export async function makeAliasFixture(content = "alpha beta gamma\n"): Promise<AliasFixture> {
  // The NATIVE realpath: on a Windows host whose TEMP is itself an 8.3 short
  // name, the JS flavour would keep that alias in the fixture's "long" path and
  // the product would then expand it. The fixture must not depend on how the
  // host spells its temp directory.
  const dir = fsSync.realpathSync.native(
    await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-alias-")),
  );
  const longPath = path.join(dir, LONG_NAME);
  const aliasPath = path.join(dir, ALIAS_NAME);
  await fsp.writeFile(longPath, content, "utf-8");
  await fsp.link(longPath, aliasPath);
  return {
    dir,
    longPath,
    aliasPath,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Run the expansion as `win32`, with a native realpath that expands
 * `ALIAS_NAME` to `LONG_NAME` and the real `lstat`. Returns the two spies.
 */
export function installAliasExpansion(opts: { realpathError?: NodeJS.ErrnoException } = {}) {
  const realpathNative = vi.fn(async (p: string): Promise<string> => {
    if (opts.realpathError) throw opts.realpathError;
    const real = await fsp.realpath(p);
    return path.basename(real) === ALIAS_NAME ? path.join(path.dirname(real), LONG_NAME) : real;
  });
  const lstat = vi.fn((p: string) => fsp.lstat(p, { bigint: true }));
  _setShortNameDepsForTests({ platform: "win32", realpathNative, lstat });
  return { realpathNative, lstat };
}

export function uninstallAliasExpansion(): void {
  _setShortNameDepsForTests(null);
}

/** A Y.Doc holding `markdown`, parsed the way an open parses a file. */
export async function docFromMarkdown(markdown: string): Promise<Y.Doc> {
  const adapter = getAdapter("md");
  const prepared = await adapter.parse(markdown);
  const doc = new Y.Doc();
  withInternal(doc, () => adapter.apply(doc, prepared));
  return doc;
}

/**
 * Drop every open document the way a process exit does: durable annotation
 * writes are flushed, then the registry, the Y.Docs, the tombstone ledger and
 * the dirty state are gone. Files on disk are untouched.
 */
export async function simulateRestart(): Promise<void> {
  for (const [id, state] of [...getOpenDocs()]) {
    await closeStore(docHash(state.filePath)).catch(() => {});
    clearFileSyncContext(id);
    removeDoc(id);
    removeDocument(id);
  }
  await quiesceForTesting();
  syncReset();
  dirtyReset();
  _resetShortNameAdoptionForTests();
}
