// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AnnotationBody from "../../src/client/panels/AnnotationBody.svelte";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import { TUTORIAL_ANNOTATIONS } from "../../src/server/mcp/tutorial-annotations";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types";
import { makeAnnotation as makeBaseAnnotation } from "../helpers/ydoc-factory.js";

function body(props: { text: string; author?: string; placeholder?: string }) {
  return render(AnnotationBody, {
    props: { author: undefined, ...props } as never,
  }).container;
}

describe("AnnotationBody — who gets markdown", () => {
  it("renders markdown for claude-authored text", () => {
    const c = body({ text: "**bold** and `code`", author: "claude" });

    expect(c.querySelector("strong")?.textContent).toBe("bold");
    expect(c.querySelector("code")?.textContent).toBe("code");
  });

  it("renders user-authored text literally, asterisks and all", () => {
    // The reason this gate exists. A user typing `*load* bearing*` means
    // asterisks; silently italicising their prose would be editing it.
    const c = body({ text: "*load* bearing*", author: "user" });

    expect(c.querySelector("em")).toBeNull();
    expect(c.textContent).toBe("*load* bearing*");
  });

  it("renders imported word text literally too", () => {
    // `author: "import"` is a Word comment. It is not markdown and was never
    // written as markdown, so formatting it would misrepresent the source
    // document rather than reveal anything.
    const c = body({ text: "# not a heading", author: "import" });

    expect(c.querySelector("h1")).toBeNull();
    expect(c.textContent).toBe("# not a heading");
  });

  it("renders literally when the author is unknown", () => {
    // Fails toward plain text: an author this component has never heard of is
    // not a reason to start interpreting their punctuation.
    expect(body({ text: "**x**", author: undefined }).querySelector("strong")).toBeNull();
  });

  it("shows the placeholder when the text is empty, without formatting it", () => {
    const c = body({ text: "", author: "claude", placeholder: "(no note)" });
    expect(c.textContent).toBe("(no note)");
  });
});

describe("AnnotationBody — block-level markup needs a block-level host", () => {
  it("never puts a block child inside a <p>", () => {
    // The bug that made #1626 part 1 more than a one-line change. All three
    // render targets were `<p>`, and `<p><pre>` / `<p><h1>` are invalid: the
    // parser silently closes the `<p>` and reparents the block, so the layout
    // breaks in a way that reads as a CSS bug rather than a markup one.
    //
    // Asserted structurally, so it fails on any host element that cannot
    // legally contain a block — not just on the specific one we started with.
    const c = body({
      text: "para one\n\npara two\n\n```js\ncode\n```\n\n# heading",
      author: "claude",
    });

    for (const block of Array.from(c.querySelectorAll("p, pre, h1, h2, h3, li, div"))) {
      expect(block.closest("p") === block || block.closest("p") === null).toBe(true);
    }
    expect(c.querySelector("pre")).not.toBeNull();
    expect(c.querySelector("h1")).not.toBeNull();
  });

  it("carries the shared markdown class so the global stylesheet reaches it", () => {
    // The rules live in `markdown-body.css` (global, shared with ChatPanel), not
    // in this component's `<style>`. Losing the class is a silent regression:
    // the markup still renders, unstyled, with UA-blue links and a `<pre>` that
    // scrolls the rail sideways.
    expect(body({ text: "x", author: "claude" }).querySelector(".tandem-markdown")).not.toBeNull();
    // ...and never on the plain branch, which must not inherit code/link styling.
    expect(body({ text: "x", author: "user" }).querySelector(".tandem-markdown")).toBeNull();
  });
});

describe("AnnotationBody — clicking a link must not also activate the card", () => {
  // Exercised through a real AnnotationCard rather than a hand-built ancestor.
  //
  // Svelte 5 DELEGATES `click` to the app root, so `stopPropagation` inside a
  // handler stops Svelte's own walk up the tree — not native bubbling. A test
  // that attaches a plain `addEventListener` to a parent element measures the
  // native chain, which the card's `onclick` is not in, and reports a failure
  // that does not exist in the app. The card's handler is delegated exactly as
  // this component's is, so composing the two is the only assertion that means
  // anything.
  function cardWith(content: string) {
    const onClick = vi.fn();
    const { container } = render(AnnotationCard, {
      props: {
        annotation: makeBaseAnnotation({
          id: "a1",
          type: "comment",
          author: "claude",
          content,
          range: { from: toFlatOffset(0), to: toFlatOffset(1) },
          timestamp: 0,
        }) as Annotation,
        onClick,
      },
    });
    return { container, onClick };
  }

  it("does not activate the card when the click started on a link", () => {
    // The card's onClick scrolls the document to the annotation. Without the
    // guard, following a link in a Claude comment both navigates AND scrolls
    // the document out from under the user.
    const { container, onClick } = cardWith("[docs](https://x.test)");
    const anchor = container.querySelector("a");

    expect(anchor).not.toBeNull();
    anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("still activates the card when the click started on ordinary body text", () => {
    // The other half. Swallowing every click inside the body would make the
    // card unclickable wherever a Claude comment has text — which is all of them.
    const { container, onClick } = cardWith("just prose");
    // The markdown host itself, not a `<p>`: a single-paragraph message has no
    // `<p>` at all, because the paragraph pass only fires on a blank-line split.
    const text = container.querySelector(".tandem-markdown");

    expect(text?.textContent).toBe("just prose");
    text?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("AnnotationBody — the shapes a clamped card has to survive", () => {
  // These pin the MARKUP the density rules in `AnnotationCard.svelte` have to
  // flatten. They cannot pin the layout — happy-dom has no layout — but they
  // fail if `renderMarkdown` stops emitting the shape those rules target, which
  // is how a CSS rule quietly stops covering anything.
  it("emits a <br> between list items, not just <li> elements", () => {
    // The reason `display: inline` alone was not enough: `renderMarkdown` turns
    // every single newline into `<br>`, so a bullet list — the likeliest thing
    // Claude writes into a comment — carries one line break per item on top of
    // the `<li>` boxes. A `<br>`'s normal display IS inline, so flattening the
    // blocks left every break in place and the one-line teaser stayed N lines.
    const c = body({ text: "Findings:\n- alpha\n- beta", author: "claude" });

    expect(c.querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelectorAll("br").length).toBeGreaterThan(0);
  });

  it("keeps literal newlines inside a fenced block", () => {
    // The other half: `<pre>` carries `white-space: pre-wrap`, which keeps
    // honouring these newlines even once the box is inline — so the density rule
    // has to reset `white-space` too, not just `display`.
    const pre = body({ text: "```ts\na\nb\n```", author: "claude" }).querySelector("pre");
    expect(pre?.textContent).toContain("\n");
  });
});

describe("AnnotationBody — the tutorial is not accidentally reformatted", () => {
  it("renders every tutorial annotation's content as its literal prose", () => {
    // Tutorial annotations ship with `author: "claude"`, so they now take the
    // markdown branch. Their copy is prose — but it is the first thing a new
    // user sees, and a stray `*` or `#` added to it later would render as
    // formatting instead of as the character someone typed. This is the guard
    // on that, and it fails at the point the copy changes rather than in a
    // screenshot review.
    for (const def of TUTORIAL_ANNOTATIONS) {
      const c = body({ text: def.content, author: "claude" });
      expect(c.textContent, def.id).toBe(def.content);
      expect(c.querySelector("strong, em, h1, h2, h3, code, pre, li, a"), def.id).toBeNull();
    }
  });
});
