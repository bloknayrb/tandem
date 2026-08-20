/**
 * The render-time SCHEME ALLOWLIST (#1537).
 *
 * **This file exists at this path on purpose.** The load-bearing pin here is
 * that `ms-msdt:/id` is REFUSED, and the only term that refuses it is
 * `isRenderableLinkScheme`. The two files this would naturally live in —
 * `url-safety.test.ts` and `link-target-internal.test.ts` — are both rewritten
 * by the still-open `fix/1420-auxclick-link-intercept` (#1545), whose own
 * predicate returns `true` for `ms-msdt:/id` and whose tests assert exactly
 * that. A merge resolution taking that branch's side would drop the new term
 * and its canary together, and the suite would go green with the hole reopened.
 * A NEW path has no merge base and survives any resolution. Corpus rows added
 * to the other two files are documentation; the pins are here.
 *
 * What this file does NOT claim: it does not claim to close the backslash
 * authority spellings. `/\evil.com/x.md` and `" /\evil.com/x.md"` are asserted
 * TRUE below, with the reason. Those are #1545's clauses 1 and 4.
 */

import { Editor } from "@tiptap/core";
import { isAllowedUri as tiptapDefaultIsAllowedUri } from "@tiptap/extension-link";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { applyLink } from "../../src/client/editor/toolbar/handlers";
import {
  isRenderableLinkScheme,
  SAFE_EXTERNAL_PREFIXES,
} from "../../src/client/editor/utils/url-safety";
import type { TandemNotification } from "../../src/shared/types";

let open: { editor: Editor; container: HTMLDivElement } | null = null;

afterEach(() => {
  open?.editor.destroy();
  open?.container.remove();
  open = null;
});

function mountEditor(content: string): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({ element: container, extensions: buildSchemaExtensions(), content });
  open = { editor, container };
  return editor;
}

/**
 * Apply the `link` MARK through the production schema.
 *
 * This is the entry point that matters for the delivery path: a crafted `.md`
 * reaches the Y.Doc through `mdast-ydoc.ts`, which writes `link: { href:
 * node.url }` VERBATIM (line 454) — the mark is built server-side and never
 * passes through Tiptap's `parseHTML` getAttrs. So the mark path, not the HTML
 * path, is where a refusal has to bite.
 */
function renderLinkMark(href: string): { anchor: HTMLAnchorElement | null; html: string } {
  const editor = mountEditor("<p>link text</p>");
  const { state, view } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) throw new Error("the link mark is missing from the production schema");
  view.dispatch(state.tr.addMark(1, state.doc.content.size - 1, linkType.create({ href })));
  return { anchor: open?.container.querySelector("a") ?? null, html: editor.getHTML() };
}

/** The OS-protocol-handler corpus from the issue. */
const REFUSED_SCHEME_HREFS = [
  "ms-msdt:/id", // Follina, CVE-2022-30190
  "ms-appinstaller:?source=http://evil/x.msix", // CVE-2021-43890
  "search-ms:crumb=location:\\\\evil.com\\share", // NTLM/WebDAV share
  "ms-officecmd:x",
  "view-source:http://evil",
  "itms-services://?url=http://evil",
];

/**
 * Hrefs Tiptap's `defaultValidate` ACCEPTS — so they are evidence that the
 * mechanism is not "hyphenated schemes" — but which no URL parser reads as
 * scheme-bearing. They render, and that is CORRECT: each resolves as an
 * ordinary relative path, and Tandem opened the ones naming a linkable file.
 *
 * This group is the second edge of the same rule. "Only render as a link if it
 * works as a link" is violated just as badly by subtracting a link that worked,
 * and an earlier draft of this change did exactly that: it used
 * `hasSchemePrefix` (a `:` before the first `/`, `#` or `?`) as its scheme
 * test, which called `2024:plan.md` scheme-bearing. Measured over 300k
 * generated hrefs, 397 distinct spellings in that class went live -> blank.
 * Clause 2 is now {@link WHATWG_SCHEME_PREFIX}'s grammar, so this file and the
 * browser agree on what "schemeless" means.
 */
const NOT_A_SCHEME_BY_THE_URL_GRAMMAR = [
  "ms_msdt:x", // `_` is not a legal scheme character
  "user@host:x", // nor is `@`
  "2024:plan.md", // scheme-start state rejects a leading DIGIT
  ".hidden:note.md", // ...and a leading `.`
  "12:30 notes.md", // both, plus a space
  ":alert(1)", // degenerate: nothing at all before the colon
];

/**
 * Schemes Tiptap allowlists that `SAFE_EXTERNAL_PREFIXES` does not. Dropping
 * these is Bryan's product call — "only render as a link if it works as a
 * link" — not a security fix: each already died in `openHref` at
 * `resolveRelativeLink`'s `unsupported-ext` with a VISIBLE `notifyLinkProblem`
 * warning. The render was the only half that pretended they worked.
 */
const NEVER_WORKED_SCHEME_HREFS = [
  "tel:+15551234",
  "sms:+15551234",
  "callto:+15551234",
  "cid:part1.abc@example.com",
  "xmpp:someone@example.com",
  "ftps://example.com/x", // NOT `ftp://` — the allowlist prefix test says false
];

describe("isRenderableLinkScheme — the allowlist posture (#1537)", () => {
  it.each(REFUSED_SCHEME_HREFS)("refuses the OS-protocol href %j", (href) => {
    expect(isRenderableLinkScheme(href)).toBe(false);
  });

  it.each(NEVER_WORKED_SCHEME_HREFS)("refuses %j, which never worked on click", (href) => {
    expect(isRenderableLinkScheme(href)).toBe(false);
  });

  it.each(SAFE_EXTERNAL_PREFIXES)("accepts the allowlisted prefix %s", (prefix) => {
    expect(isRenderableLinkScheme(`${prefix}example.com/x`)).toBe(true);
  });

  it("keeps mailto:, which was TRACED rather than assumed", () => {
    // The one allowlist entry nobody had traced. `openHref` calls
    // `isSafeExternalHref` FIRST, and `"mailto:"` is a literal entry in
    // SAFE_EXTERNAL_PREFIXES — so a mailto: href takes the `window.open`
    // branch and never reaches `resolveRelativeLink`. That is what makes it
    // materially different from `tel:` above, which does reach it and dies at
    // `unsupported-ext`. Under "only render as a link if it works as a link",
    // mailto: passes and stays.
    expect(isRenderableLinkScheme("mailto:someone@example.com")).toBe(true);
    expect(isRenderableLinkScheme("MailTo:someone@example.com")).toBe(true);
    expect(isRenderableLinkScheme("mailto:a@b.com?subject=hi")).toBe(true);
  });

  it.each([
    "notes.md",
    "./notes.md",
    "../docs/spec.md",
    "docs/spec.md",
    "Docs/spec.md",
    "subdir/file.md#frag",
    "docs/spec.md?x=1",
    "/abs/path.md",
    "#frag",
    "my file.md",
  ])("does not touch the schemeless href %j — that is not this predicate's question", (href) => {
    expect(isRenderableLinkScheme(href)).toBe(true);
  });

  it("refuses empty input", () => {
    expect(isRenderableLinkScheme("")).toBe(false);
    expect(isRenderableLinkScheme(null)).toBe(false);
    expect(isRenderableLinkScheme(undefined)).toBe(false);
  });

  it.each(
    NOT_A_SCHEME_BY_THE_URL_GRAMMAR,
  )("renders %j — the URL parser sees no scheme there, so neither does this", (href) => {
    // The other edge of "only render as a link if it works as a link". Each
    // row resolves relative under the real parser, which is the definition of
    // schemeless being used here.
    expect(new URL(href, "http://localhost:5173/doc/a.md").protocol).toBe("http:");
    expect(isRenderableLinkScheme(href)).toBe(true);
  });

  it("must still render 2024:plan.md — the regression this pins", () => {
    // Named explicitly rather than left inside the loop above. `2024:plan.md`
    // is a real filename shape (colons are legal on POSIX/macOS, illegal on
    // Windows), it reached `resolveRelativeLink` -> `{ok:true}` ->
    // `openServerPath`, and the first draft of this change blanked it. If this
    // row ever goes red, clause 2 has drifted back off the URL grammar.
    expect(isRenderableLinkScheme("2024:plan.md")).toBe(true);
    const { anchor } = renderLinkMark("2024:plan.md");
    expect(anchor?.getAttribute("href")).toBe("2024:plan.md");
    expect(anchor?.hasAttribute("data-tandem-link-blocked")).toBe(false);
  });

  it("still subtracts a filename that spells a SYNTACTICALLY VALID scheme", () => {
    // The one residue of clause 2, named so nobody rediscovers it from a bug
    // report. `my-file` is a legal scheme (ALPHA then alnum/+/-/.), so a
    // browser reads `my-file:v2.md` as an opaque non-special URL, NOT as a
    // path relative to the document — the anchor never resolved the way
    // Tandem's segment walk pretended it did. Refusing to render it is the
    // rule applied, not an exception to it.
    expect(new URL("my-file:v2.md", "http://localhost:5173/doc/a.md").protocol).toBe("my-file:");
    expect(isRenderableLinkScheme("my-file:v2.md")).toBe(false);
  });

  it.each([
    "http:/\\evil.com/x",
    "https:/evil.com/x",
    "https:/\\evil.com/x",
    "http:\\\\evil.com\\x",
    "HTTP:/\\evil.com/x",
    "ftp:/\\evil.com/x",
  ])("refuses the lenient-authority spelling %j of a special scheme", (href) => {
    // These carry an ALLOWLISTED scheme in a spelling `isSafeExternalHref`
    // does not recognise (it is a literal `"http://"` prefix test), and they
    // resolve cross-host. The general scheme branch covers them, which is why
    // it can REPLACE #1545's narrower `SPECIAL_EXTERNAL_SCHEME` clause on
    // merge rather than sit beside it.
    expect(isRenderableLinkScheme(href)).toBe(false);
  });

  it("does NOT close the backslash-authority spellings — those need #1545", () => {
    // Deliberately asserted TRUE. This predicate answers the SCHEME question
    // only, and these carry no scheme, so clause 3 returns true and they still
    // render on this branch. They are closed by the leading-whitespace and
    // `rejectUnsafeWindowsPrefix` clauses of `isRenderableLinkHref` on
    // `fix/1420-auxclick-link-intercept` (#1545), which is still open.
    //
    // A test claiming otherwise would be a lie the suite tells, and it is the
    // exact lie the naive merge produces: folding this predicate in as
    // #1545's FINAL clause deletes `rejectUnsafeWindowsPrefix` and turns all
    // of these back on. It must replace #1545's clause 3, not its clause 4.
    for (const href of [
      "/\\evil.com/x.md",
      "\\/evil.com/x.md",
      "\\\\evil.com\\share\\x.md",
      "\\\\?\\C:\\x.md",
      " /\\evil.com/x.md",
      " //example.com/x",
    ]) {
      expect(isRenderableLinkScheme(href), `${href} is NOT subtracted by this predicate`).toBe(
        true,
      );
    }
  });

  it("leaves the percent- and full-width-colon spellings live, and correctly so", () => {
    // Not holes. `new URL()` decodes neither into a scheme, so both resolve as
    // ordinary relative paths under the document origin — measured:
    //   new URL("ms-msdt%3a/id", "http://localhost:5173/doc").protocol === "http:"
    //   new URL("ms-msdt\uFF1A/id", "http://localhost:5173/doc").protocol === "http:"
    // Refusing them would be a narrowing with no threat behind it.
    expect(new URL("ms-msdt%3a/id", "http://localhost:5173/doc").protocol).toBe("http:");
    expect(new URL("ms-msdt\uFF1A/id", "http://localhost:5173/doc").protocol).toBe("http:");
    expect(isRenderableLinkScheme("ms-msdt%3a/id")).toBe(true);
    expect(isRenderableLinkScheme("ms-msdt\uFF1A/id")).toBe(true);
  });
});

describe("the premise: what Tiptap's defaultValidate actually accepts", () => {
  // Asserted against the REAL dependency, never re-derived from the vendored
  // source: the pattern is assembled in a template literal where `\-` collapses
  // to a bare `-`, so `[^a-z+.-:]` parses `.-:` as the range U+002E-U+003A and
  // the hyphen falls OUT of the negated set. Reading the source gives the wrong
  // answer; only `new RegExp` gives the right one.
  it.each([
    ...REFUSED_SCHEME_HREFS,
    ...NEVER_WORKED_SCHEME_HREFS,
  ])("accepts %j — which is why the narrowing term exists", (href) => {
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeTruthy();
  });

  it.each(
    NOT_A_SCHEME_BY_THE_URL_GRAMMAR,
  )("accepts %j too — which is why the mechanism is NOT about hyphens", (href) => {
    // `_`, `@`, a leading digit, a leading `.` and a space are all outside
    // the collapsed range, so `defaultValidate` waves each of these through
    // exactly as it does `ms-msdt:/id`. The difference is downstream: no URL
    // parser reads a scheme here, so these stay relative and stay live. A
    // narrowing term that keyed on "has a colon" would have blanked them.
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeTruthy();
    expect(isRenderableLinkScheme(href)).toBe(true);
  });

  // UPSTREAM-DRIFT DETECTORS. These four are rejected by `defaultValidate`
  // today because a terminator INSIDE `[a-z+./0-9:]` cannot end the
  // `[a-z0-9+.-]+` run. They are rejected by `isRenderableLinkScheme`
  // independently of that, so the union is unaffected either way — the point
  // is to NOTICE. If a `@tiptap/extension-link` upgrade changes that
  // terminator set in EITHER direction these flip and the paragraph above
  // stops describing the dependency. The narrowing direction counts: upstream
  // escaping `\-` properly removes the `.-:` RANGE, which takes `/` and the
  // digits back out of the excluded set, so `ms2:x` moves too — not only a
  // widening upgrade can break this.
  it.each([
    "coap+tcp:x",
    "a.b:c",
    "x+y:z",
    "ms2:x",
  ])("rejects %j today — a terminator inside [a-z+./0-9:] does not end the run", (href) => {
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeFalsy();
    expect(isRenderableLinkScheme(href)).toBe(false);
  });
});

describe("end-to-end through the production schema (the mark path a .md import uses)", () => {
  it.each([
    ...REFUSED_SCHEME_HREFS,
    ...NEVER_WORKED_SCHEME_HREFS,
  ])("blanks %j and leaks it nowhere", (href) => {
    const { anchor, html } = renderLinkMark(href);
    // Positive control FIRST: an anchor really rendered, so the assertions
    // below are about the guard rather than about a mark that failed to
    // apply. Without this row every absence-assertion passes vacuously.
    expect(anchor, "no anchor rendered — the assertions below would be vacuous").toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe("");
    // A disallowed scheme is never given a title and never resurrected.
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(anchor?.hasAttribute("target")).toBe(false);
    // The refused href reaches the DOM nowhere at all — not in an attribute,
    // not in a tooltip, not in text. This is what makes "no title" a
    // semantic claim rather than a single-attribute one.
    expect(html).not.toContain(href);
    expect(anchor?.outerHTML).not.toContain(href);
  });

  it("marks a blanked anchor so the CSS can stop it looking clickable", () => {
    // `.tandem-editor a[href]` matches an EMPTY href too, so a refused link
    // kept `cursor: pointer` and did nothing on click. The attribute carries
    // no href-derived data — deliberately not a `title` (#1537 / bidi).
    const { anchor } = renderLinkMark("ms-msdt:/id");
    expect(anchor?.getAttribute("data-tandem-link-blocked")).toBe("true");
  });

  it("leaves an allowlisted external link untouched — the did-not-overshoot control", () => {
    const { anchor } = renderLinkMark("https://example.com/page");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/page");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("title")).toBe("https://example.com/page");
    expect(anchor?.hasAttribute("data-tandem-link-blocked")).toBe(false);
  });

  it.each([
    "mailto:someone@example.com",
    "docs/spec.md",
    "./notes.md",
    "//example.com/page",
  ])("leaves %j live — the did-not-overshoot control for the kept set", (href) => {
    const { anchor } = renderLinkMark(href);
    expect(anchor?.getAttribute("href")).toBe(href);
    expect(anchor?.hasAttribute("data-tandem-link-blocked")).toBe(false);
  });
});

describe("what the narrowing must NOT have moved", () => {
  function linkOptions(editor: Editor): Record<string, unknown> {
    const ext = editor.extensionManager.extensions.find((e) => e.name === "link");
    if (!ext) throw new Error("the link extension is missing from the production schema");
    return ext.options as Record<string, unknown>;
  }

  it("holds autolink at exactly today's behaviour (#1377's pin, unmoved)", () => {
    // Read this carefully before "fixing" it: `example.com/path` NOT
    // autolinking is the SHIPPED, DELIBERATE behaviour. `shouldAutoLink`
    // substitutes the vendored default so typing `example.com/path ` does not
    // write markdown link syntax into the user's file on a keystroke.
    // `tests/client/link-target-internal.test.ts` pins the same row; this
    // duplicate is here so a merge that drops that file still catches a
    // narrowing term that accidentally reached the autolink surface.
    const editor = mountEditor("<p>x</p>");
    const fn = linkOptions(editor).shouldAutoLink as (url: string) => boolean;
    expect(fn("example.com/path")).toBe(false);
    expect(fn("notes.md")).toBe(true);
  });

  it("still accepts example.com/path on the PASTE RULE — the positive control", () => {
    // This is where the "did not overshoot" evidence belongs: the linkify
    // markPasteRule reads `isAllowedUri`, so if the new AND term were too
    // broad this would flip to false. Asserting it on `shouldAutoLink`
    // instead would be a red test whose obvious fix deletes #1377's pin.
    const editor = mountEditor("<p>x</p>");
    const isAllowedUri = linkOptions(editor).isAllowedUri as (
      url: string,
      ctx: { defaultValidate: (u: string) => boolean },
    ) => boolean;
    const ctx = { defaultValidate: (u: string) => !!tiptapDefaultIsAllowedUri(u, []) };
    expect(isAllowedUri("example.com/path", ctx)).toBe(true);
    expect(isAllowedUri("docs/spec.md", ctx)).toBe(true);
    expect(isAllowedUri("ms-msdt:/id", ctx)).toBe(false);
  });

  it("refuses ms-msdt: through setLink, the command surface", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: "ms-msdt:/id" })).toBe(false);
    expect(editor.commands.setLink({ href: "docs/spec.md" })).toBe(true);
  });
});

describe("the AUTHORING path says the refusal out loud", () => {
  // The render gate is reached by two routes, not one. `setLink` consults the
  // same `isAllowedUri` union, so the moment the allowlist landed, typing
  // `tel:+15551234` into the Link editor started returning `false` and writing
  // nothing — where before the change it succeeded. That is STRICTLY LESS
  // visible than the behaviour it replaced, which is the opposite of the point
  // of this change: `openHref`'s refusals are announced (`notifyLinkProblem`,
  // #1377) and this one was not. `applyLink` now reports through the same
  // channel, threaded from App's `notifications.push` via `Toolbar` and
  // `FormattingBar`, and directly from `Editor.svelte` for the context menu.
  it("reports a refused href instead of silently no-oping", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    const seen: TandemNotification[] = [];
    expect(applyLink(editor, "tel:+15551234", (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.severity).toBe("warning");
    expect(seen[0]?.errorCode).toBe("LINK_NOT_OPENABLE");
    expect(seen[0]?.message).toContain("tel:+15551234");
    // Past tense: `warning` persists in the activity tray, which is a log.
    expect(seen[0]?.message).toContain("Didn't create the link");
    // ...and nothing was written, which is why the message is the only signal.
    expect(editor.getHTML()).not.toContain("<a ");
  });

  it("reports the OS-protocol corpus too, not just the never-worked schemes", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    const seen: TandemNotification[] = [];
    expect(applyLink(editor, "ms-msdt:/id", (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("stays silent when the href is accepted — the did-not-overshoot control", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    const seen: TandemNotification[] = [];
    expect(applyLink(editor, "docs/spec.md", (n) => seen.push(n))).toBe(true);
    expect(seen).toHaveLength(0);
    expect(editor.getHTML()).toContain('href="docs/spec.md"');
  });

  it("stays silent for 2024:plan.md — the F4 row, on the authoring surface", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    const seen: TandemNotification[] = [];
    expect(applyLink(editor, "2024:plan.md", (n) => seen.push(n))).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
