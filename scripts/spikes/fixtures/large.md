# Large Fixture for Latency Measurement

This file is intentionally repetitive to approximate ~10 pages of body text
(~3000 words). It is used by the spike to time soffice round-trip latency
for a realistic Tandem document.

## Section A

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

- **Bold bullet one** describing a long sentence with several clauses, each
  contributing meaningful prose so the resulting `.docx` has realistic
  paragraph density when LibreOffice serializes it back to Word format.
- *Italic bullet two* continuing the same idea with additional clauses,
  references like [the Tandem repo](https://github.com/bloknayrb/tandem), and
  `inline code` segments that the export filter must preserve correctly.
- Plain bullet three exercising soft wrapping and the default paragraph
  spacing that LibreOffice applies during the HTML to OOXML conversion.

> A blockquote that summarizes the section, since blockquotes are one of the
> formats Tandem must preserve on round-trip through soffice headless.

## Section B

The same paragraph repeated to grow the document body so the latency
measurement is meaningful. LibreOffice cold-start dominates a single small
conversion but is amortized as the document grows.

Tandem's annotation export target is Word comments (`w:commentRangeStart`,
`w:commentRangeEnd`, `w:commentReference`). The discriminating question for
this spike is whether soffice can be coerced into emitting those markers
from an authored intermediate format.

## Section C

A nested bullet block to vary the body:

- Outer one
  - Inner one with **emphasis**
  - Inner two with `code`
- Outer two
  - Inner three with [link](https://example.com)
- Outer three

## Section D

A table to vary content density:

| Column A | Column B | Column C | Column D |
| --- | --- | --- | --- |
| a1 | b1 | c1 | d1 |
| a2 | b2 | c2 | d2 |
| a3 | b3 | c3 | d3 |
| a4 | b4 | c4 | d4 |
| a5 | b5 | c5 | d5 |

## Section E (repeated body)

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

Tandem is a collaborative AI-human document editor. The fixture below
exercises headings, paragraphs, bullets, and inline marks. Tandem stores
annotations in a Y.js CRDT map keyed by annotation ID. Each annotation
carries a flat-offset range plus a Yjs RelativePosition for CRDT survival.

## Section F

End of large fixture. Roughly enough text to fill ~8-10 pages depending on
default Word margins and font.
