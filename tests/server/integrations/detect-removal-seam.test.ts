/**
 * Who may call `detectRemovalTargets` (#2144).
 *
 * It finds MSIX configs under package names that every WRITE path refuses
 * (`MSIX_PACKAGE_PATTERN`), so that the uninstall scrub can remove a Tandem
 * entry wherever one could have ended up. Bryan decided the wider set is for
 * removal only (2026-10-06). It is a separate function rather than a
 * `DetectOptions` flag because options objects are forwarded whole; this pin
 * is the other half, catching a write path that imports it directly.
 */

import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES } from "../../helpers/src-tree.js";

describe("detectRemovalTargets seam", () => {
  it("is defined in apply.ts and used only by the uninstall scrub", () => {
    expect(SRC_FILES.size, "control: the sweep found source files").toBeGreaterThan(100);
    expect(filesMentioning("detectRemovalTargets")).toStrictEqual([
      "src/cli/uninstall-scrub.ts",
      "src/server/integrations/apply.ts",
    ]);
  });
});
