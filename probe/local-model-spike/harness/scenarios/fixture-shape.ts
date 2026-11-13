/**
 * The product's inline threshold, for checking fixture shapes. A fixture that
 * claims to be "deep" or "just under" is only that relative to the number the
 * collaborator really uses, so it is imported, never restated.
 */
import { INLINE_CHAR_LIMIT } from "../../../../src/server/local-model/collaborator.js";

/** A document whose extracted text is at most this long is inlined into the prompt. */
export function inlineLimit(): number {
  return INLINE_CHAR_LIMIT;
}
