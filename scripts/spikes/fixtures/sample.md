# LibreOffice Headless Spike Fixture

This file exercises the formatting Tandem needs to round-trip through `soffice --convert-to docx`.

## Inline marks

A paragraph with **bold**, *italic*, ***bold italic***, ~~strikethrough~~, and `inline code`. It also contains a [link to the Tandem repo](https://github.com/bloknayrb/tandem).

## Lists

- First bullet
- Second bullet with **bold** inside
  - Nested bullet
- Third bullet

1. Ordered one
2. Ordered two
3. Ordered three

## Table

| Column A | Column B | Column C |
| --- | --- | --- |
| a1 | b1 | c1 |
| a2 | **b2** | c2 |

## Blockquote

> This is a blockquote. Tandem allows Claude to leave comments inside these.

## Code block

```ts
export function hello(name: string): string {
  return `Hello, ${name}`;
}
```

End of fixture.
