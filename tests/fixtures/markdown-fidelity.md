# Markdown fidelity fixture

This fixture exercises every CommonMark + GFM construct Tandem cares about for
the #981 round-trip audit. Paragraph text with **bold**, *italic*, ~~strike~~,
`inline code`, and an [inline link](https://example.com "Title").

A bare autolink: https://example.com and an email autolink: user@example.org.

A hard break ends this line\
and continues here.

> A blockquote.
>
> > Nested deeper.

- Bullet one
- Bullet two
  - Nested bullet
- Bullet three

1. Ordered one
2. Ordered two

An intervening paragraph keeps the next list from merging with the previous one.

7. Ordered with a custom start
8. Next item

```ts
const x: number = 42;
```

---

| Left | Center | Right |
| :--- | :----: | ----: |
| a1   | b1     | c1    |
| a2   | **b2** | c2    |

![Standalone image](https://example.com/image.png "Alt title")

<div class="raw-html-block">A raw HTML block.</div>

Some <span>inline HTML</span> wrapping prose, plus a stray `<` that stays text.

A paragraph with a footnote reference[^note] and two consecutive ones[^a][^b].

[^note]: The footnote definition body.

[^a]: First.

[^b]: Second.

A reference-style [full link][ref], a [collapsed][] one, and a [shortcut].

[ref]: https://example.com/ref "Ref title"

A paragraph sitting between two reference definitions.

[collapsed]: https://example.com/collapsed
[shortcut]: https://example.com/shortcut

- [ ] Unchecked task
- [x] Checked task

Plain bullets and checkboxes coexisting in one list:

- A plain bullet
- [ ] An unchecked task
- [x] A checked task

An ordered task list:

1. [ ] First step
2. [x] Second step
