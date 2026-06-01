import { describe, expect, it } from "vitest";
import type { DecorationVisibility } from "../../src/client/editor/extensions/annotation";
import { shouldPing } from "../../src/client/editor/extensions/annotationPing";
import type { Annotation } from "../../src/shared/types";

// Pure arrival-predicate coverage for the A4 gutter ping (#798). The decoration
// plumbing (paragraph resolution, fire→remove lifecycle) is exercised by the
// empirical probe; this pins the gate logic without mounting ProseMirror.

const ALL_VISIBLE: DecorationVisibility = { comment: true, highlight: true, note: true };

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    type: "comment",
    status: "pending",
    timestamp: 1,
    ...over,
  } as Annotation;
}

describe("shouldPing", () => {
  // Each row is an equivalence class — the `why` column makes a missing class visible.
  const cases: Array<{
    why: string;
    ann: Annotation | undefined;
    isLive: boolean;
    alreadySeen: boolean;
    visible: DecorationVisibility;
    expected: boolean;
  }> = [
    {
      why: "happy path: live, unseen, pending, visible type → ping",
      ann: ann(),
      isLive: true,
      alreadySeen: false,
      visible: ALL_VISIBLE,
      expected: true,
    },
    {
      why: "not live yet (settling window / bulk load) → suppressed",
      ann: ann(),
      isLive: false,
      alreadySeen: false,
      visible: ALL_VISIBLE,
      expected: false,
    },
    {
      why: "already seen (live observer re-fire on an existing id) → no re-ping",
      ann: ann(),
      isLive: true,
      alreadySeen: true,
      visible: ALL_VISIBLE,
      expected: false,
    },
    {
      why: "missing annotation (a delete/clear surfaced the id) → no ping",
      ann: undefined,
      isLive: true,
      alreadySeen: false,
      visible: ALL_VISIBLE,
      expected: false,
    },
    {
      why: "non-pending arrival (already accepted → no inline anchor) → no ping",
      ann: ann({ status: "accepted" }),
      isLive: true,
      alreadySeen: false,
      visible: ALL_VISIBLE,
      expected: false,
    },
    {
      why: "muted comment type (decorations menu hid comments) → no ping",
      ann: ann({ type: "comment" }),
      isLive: true,
      alreadySeen: false,
      visible: { ...ALL_VISIBLE, comment: false },
      expected: false,
    },
    {
      why: "muted note type → no ping (note maps to the note visibility key)",
      ann: ann({ type: "note" }),
      isLive: true,
      alreadySeen: false,
      visible: { ...ALL_VISIBLE, note: false },
      expected: false,
    },
    {
      why: "imported Word comment maps to the comment key; comment muted → no ping",
      ann: ann({ type: "comment", author: "import" }),
      isLive: true,
      alreadySeen: false,
      visible: { ...ALL_VISIBLE, comment: false },
      expected: false,
    },
    {
      why: "visible note arrival → pings (notes are privacy-safe as a local cue, ADR-027)",
      ann: ann({ type: "note" }),
      isLive: true,
      alreadySeen: false,
      visible: ALL_VISIBLE,
      expected: true,
    },
  ];

  it.each(cases)("$why", ({ ann: a, isLive, alreadySeen, visible, expected }) => {
    expect(shouldPing(a, { isLive, alreadySeen, visible })).toBe(expected);
  });
});
