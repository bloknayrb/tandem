<script lang="ts">
import type { Annotation, ReplyAuthor } from "../../shared/types";
import { renderMarkdown } from "./chat-markdown";
import "./markdown-body.css";

interface Props {
  /** The body text. */
  text: string;
  /**
   * Who wrote it. Only `"claude"` renders as markdown; see below.
   *
   * The union covers both callers: annotation bodies carry `Annotation["author"]`
   * (`"user" | "claude" | "import"`) and replies carry `ReplyAuthor`.
   */
  author: Annotation["author"] | ReplyAuthor | undefined;
  /** Rendered when `text` is empty. */
  placeholder?: string;
}

let { text, author, placeholder = "" }: Props = $props();

/**
 * Markdown renders for Claude-authored text only.
 *
 * **This is a semantic choice, not a trust boundary.** A user typing `*load*
 * bearing*` in a comment means asterisks, and silently italicising their prose
 * would be editing it. Claude, by contrast, writes markdown by default — that is
 * what the issue is about.
 *
 * It is emphatically NOT a security gate, and must not be read as one:
 * `renderMarkdown`'s escaping is what makes the `{@html}` safe, and it applies
 * to every author equally. Claude's output is shaped by document and `.docx`
 * content that can come from outside the project, so this text is exactly as
 * untrusted as the user's.
 *
 * `"claude"` also covers local-model replies when #1123 M4 arms — the collaborator
 * writes with the same author value, so nothing here needs to change then.
 *
 * **Known asymmetry: `author` tracks who OWNS the annotation, not who wrote the
 * current text.** `tandem_editAnnotation` has no author gate and spreads the
 * existing record, so Claude editing a user's comment leaves `author: "user"` —
 * and that Claude-written markdown renders as literal asterisks, while the same
 * text in a comment Claude *created* renders formatted. Cosmetic, and the honest
 * fix is a separate `editedBy` field rather than rewriting `author`, which would
 * corrupt the authorship model and the header dot.
 */
const asMarkdown = $derived(author === "claude");

/**
 * The rendered text.
 *
 * `String(...)` because these values come off a Y.Map and both branches need to
 * survive a non-string. `renderMarkdown` guards itself, but the plain branch is
 * a bare `{body}` interpolation, which would stringify an object to
 * `[object Object]` — and the plain branch is where user and import text goes,
 * so it is the MAJORITY path, not the edge one.
 */
const body = $derived(typeof text === "string" ? text || placeholder : placeholder);
</script>

{#if asMarkdown}
  <!--
    The `{@html}` sink. Safe because `renderMarkdown` escapes the whole input
    before constructing any tag — see its docstring, which states the invariant
    and the one counterexample that motivated the URL guard.

    A `<div>`, never a `<p>`: markdown emits block-level children (`<p>`, `<pre>`,
    `<h1>`, `<li>`), and a block inside a `<p>` is invalid HTML that the parser
    silently reparents, breaking the layout in a way that looks like a CSS bug.
    All three annotation targets were `<p>` before #1626.
  -->
  <div class="tandem-markdown ab-body">
    {@html renderMarkdown(body)}
  </div>
{:else}
  <!-- `pre-wrap` so a user's own line breaks survive, matching what the markdown
       branch does with them. Without it the two branches disagree about
       whitespace and a comment reflows on edit. -->
  <div class="ab-body ab-plain">{body}</div>
{/if}

<style>
  .ab-plain {
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
