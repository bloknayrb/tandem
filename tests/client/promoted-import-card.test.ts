// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types";

/**
 * The whole-card view of #1714, and the two halves of it that component specs
 * on the individual surfaces cannot see.
 *
 * `AnnotationCardHeader` is tested directly for the dot and the label, but the
 * card owns two decisions the header never sees: which GROUND TINT it paints
 * (`getCardTint(getDisplayAuthor(...))`, display role) and which VARIANT
 * renders (`annotation.author`, storage role). Those read two different author
 * accessors on purpose, four lines apart, and nothing else in the suite pins
 * either against the other.
 *
 * The variant half is the one review caught: routing a promoted record into
 * `ImportedCard` because it PRESENTS as an import loses the suggestion diff —
 * that card renders a bare paragraph and has no diff block — while the shared
 * header goes on advertising a replacement glyph. The record is an ordinary
 * editable comment; only its attribution came from someone else.
 */

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    type: "comment",
    author: "user",
    status: "pending",
    content: "Body text",
    range: { from: toFlatOffset(0), to: toFlatOffset(1) },
    timestamp: 0,
    ...overrides,
  } as Annotation;
}

const PROVENANCE = { author: "Dana Reviewer", file: "/draft.docx" };

function renderCard(annotation: Annotation) {
  return render(AnnotationCard, { props: { annotation } });
}

function cardBackground(container: HTMLElement, id: string): string {
  const card = container.querySelector<HTMLElement>(`[data-testid='annotation-card-${id}']`);
  expect(card, `expected a card for ${id}`).not.toBeNull();
  return card?.getAttribute("style") ?? "";
}

describe("AnnotationCard — a promoted import's ground tint follows provenance (#1714)", () => {
  it("paints a promoted import with the import ground, not the user ground", () => {
    const { container } = renderCard(makeAnnotation({ importSource: PROVENANCE }));
    expect(cardBackground(container, "ann-1")).toContain(
      "background: var(--tandem-author-import-bg)",
    );
  });

  it("still paints an ordinary user comment with the user ground", () => {
    // The negative control. Without it, `getCardTint("import")` hard-coded
    // passes the spec above.
    const { container } = renderCard(makeAnnotation());
    expect(cardBackground(container, "ann-1")).toContain(
      "background: var(--tandem-author-user-bg)",
    );
  });

  it("shows the reviewer byline on a promoted import", () => {
    // The byline moved out of `ImportedCard` and into the shared header for
    // exactly this record: it no longer renders through that card, so a byline
    // only `ImportedCard` could draw would never reach it.
    const { container } = renderCard(makeAnnotation({ importSource: PROVENANCE }));
    const byline = container.querySelector("[data-testid='annotation-import-byline-ann-1']");
    expect(byline?.textContent).toContain("Dana Reviewer");
  });

  it("draws no byline for a record with no provenance", () => {
    const { container } = renderCard(makeAnnotation());
    expect(container.querySelector("[data-testid='annotation-import-byline-ann-1']")).toBeNull();
  });
});

describe("AnnotationCard — the card VARIANT stays on the stored author (#1714)", () => {
  it("renders a promoted import carrying a suggestion as a suggestion, diff and all", () => {
    // The regression the display split would otherwise introduce. A promoted
    // import is a pending comment with `audience: "outbound"`, and
    // `tandem_editAnnotation` sets `suggestedText` on exactly that shape with
    // no author check — so this record is reachable, not hypothetical.
    const { container } = renderCard(
      makeAnnotation({
        type: "comment",
        suggestedText: "replacement",
        textSnapshot: "original",
        importSource: PROVENANCE,
      }),
    );
    expect(container.querySelector("[data-testid='suggestion-diff-ann-1']")).not.toBeNull();
    // ...and it keeps the attribution that made this bug worth fixing.
    expect(
      container.querySelector("[data-testid='annotation-import-byline-ann-1']")?.textContent,
    ).toContain("Dana Reviewer");
  });

  it("renders an UNpromoted import through ImportedCard, checkbox and all", () => {
    // The other side of the dispatch: a genuine import still reaches the card
    // that owns batch-promote selection. Keying dispatch on the display author
    // would keep this green, so it is the tint specs above that discriminate —
    // this one guards against over-correcting the revert into "never
    // ImportedCard".
    const { container } = render(AnnotationCard, {
      props: {
        annotation: makeAnnotation({ author: "import", type: "note", importSource: PROVENANCE }),
        selected: false,
        onToggleSelect: () => {},
      },
    });
    expect(
      container.querySelector("[data-testid='annotation-select-checkbox-ann-1']"),
    ).not.toBeNull();
  });
});
