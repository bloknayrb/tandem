/**
 * Swap the `.docx` adapter under the REAL open paths, for tests that must drive
 * another adapter (ADR-052's spike adapter, or a counting wrapper) through cold
 * open, force-open, the watcher reload and session restore.
 *
 * `runRoundTrip` alone skips those paths: it never runs `loadAndMerge`,
 * `reanchorAnnotations` or the durable store, which is where a duplicate or a
 * mis-anchored comment actually shows up. Every one of them resolves its adapter
 * through `getAdapter` from `file-io/index.js`, so a `vi.mock` of that module
 * reaches them all. `tests/server/docx-adapter-override.test.ts` proves it, path
 * by path.
 *
 * **Save is deliberately out of reach.** The same mock would also swap the
 * adapter `docx-verify.ts` re-imports with, so an overridden save would have the
 * engine under test verify its own output. Drive saves through your own driver.
 *
 * Usage — the hook must come from `vi.hoisted`, because `vi.mock` factories run
 * before the file's imports:
 *
 *   const docxHook = vi.hoisted((): DocxAdapterHook => ({ adapter: undefined }));
 *   vi.mock(import("../../src/server/file-io/index.js"), async (importOriginal) =>
 *     (await import("../helpers/docx-adapter-override.js")).mockFileIoWithDocxOverride(
 *       await importOriginal(),
 *       docxHook,
 *     ),
 *   );
 *
 * Then set `docxHook.adapter` in a test, and clear it afterwards.
 */

import type * as FileIo from "../../src/server/file-io/index.js";
import type { FormatAdapter } from "../../src/server/file-io/index.js";

export interface DocxAdapterHook {
  /** When set, `getAdapter("docx")` returns this instead of the production adapter. */
  adapter: FormatAdapter | undefined;
}

export function mockFileIoWithDocxOverride(
  actual: typeof FileIo,
  hook: DocxAdapterHook,
): typeof FileIo {
  return {
    ...actual,
    getAdapter: (format: string): FormatAdapter =>
      format === "docx" && hook.adapter ? hook.adapter : actual.getAdapter(format),
  };
}
