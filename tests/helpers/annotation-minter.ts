/**
 * The wide-typed annotation minter, for tests only (ADR-035 Unit 8j).
 *
 * `AnnotationLifecycle.create` — the seam every production caller now holds —
 * mints a `comment` and nothing else, because a comment is the only thing
 * Claude may author. The test floor needs `note` and `highlight` fixtures,
 * which the seam deliberately cannot express, so it needs a wider entry point.
 *
 * Until this unit that entry point was `mcp/annotations.ts::createAnnotation`,
 * a **production** export with zero production callers whose only defence
 * against acquiring one was a census assertion. Moving it here is what makes
 * the confinement structural: a `src/` file cannot import from `tests/`.
 *
 * The body is copied verbatim rather than rewritten. That is the point — 159
 * call sites keep byte-identical fixtures, so the parity floor cannot shift
 * under a migration whose whole cost is one import line per file. Same
 * reasoning as {@link ../helpers/positions.ts}, which exists so a ~294-site fix
 * was "one import per file rather than a cast per call".
 *
 * `mintAnnotation` stays exported from `annotations/lifecycle.ts` and cannot
 * follow it here: it performs the real origin-tagged Y.Map write and fires the
 * push notification, so it is production code with a test-only caller — the
 * arrangement `acceptPending` / `dismissPending` already have, pinned by
 * `tests/server/annotation-create-seam-census.test.ts`.
 */

import type * as Y from "yjs";
import { type MintExtras, mintAnnotation } from "../../src/server/annotations/lifecycle.js";
import type { AnchoredRangeResult } from "../../src/shared/positions/index.js";
import type { AnnotationType } from "../../src/shared/types.js";

/**
 * Create an annotation of any type from an anchored range and store it in the
 * Y.Map, returning its id.
 *
 * The argument order is `(map, ydoc, …)` while `mintAnnotation` takes
 * `(ydoc, map, …)`. That inversion is inherited from the pre-ADR-035 signature
 * and is preserved on purpose: correcting it here would mean touching all 159
 * call sites, which is exactly the cost this relocation exists to avoid.
 */
export function createAnnotation(
  map: Y.Map<unknown>,
  ydoc: Y.Doc,
  type: AnnotationType,
  anchored: AnchoredRangeResult,
  content: string,
  extras?: MintExtras,
): string {
  return mintAnnotation(ydoc, map, type, anchored, content, extras).id;
}
