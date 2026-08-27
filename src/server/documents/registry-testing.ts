/**
 * The document registry's primitives, for tests only (ADR-033).
 *
 * `registry.ts` exposes `openDocument` / `activateDocument` / `updateDocument`
 * / `closeDocument` as its whole mutating surface, each ending in exactly one
 * `documentMeta` broadcast. That is what makes the two silent failure modes
 * unrepresentable: publishing an inconsistent snapshot between two primitives,
 * and advancing the activation epoch twice for one user gesture.
 *
 * Tests still need to *arrange* registry state without those broadcasts —
 * setup writes are noise at best, and they skew a write-count assertion at
 * worst. This module is that seam, and nothing else. It lives in `src/` rather
 * than `tests/` only because the state it reaches is module-private to
 * `registry.ts`.
 *
 * **Nothing under `src/` may import this file.** It is not a soft convention:
 * `tests/docs/registry-primitive-containment.test.ts` fails if any production
 * module imports it, or names the `unsafe*` exports it wraps. Reaching the
 * primitives from production code is allowed to be possible; it is not allowed
 * to be quiet.
 */

export {
  unsafeAddDoc as addDoc,
  unsafeRemoveDoc as removeDoc,
  unsafeSetActiveDocId as setActiveDocId,
} from "./registry.js";
