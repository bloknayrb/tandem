<script lang="ts">
import type { Annotation, ReplyAuthor } from "../../shared/types";
import { renderMarkdown } from "./chat-markdown";
import "./markdown-body.css";

interface Props {
  /** The body text. Non-string values are tolerated — `renderMarkdown` returns "". */
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
 */
const asMarkdown = $derived(author === "claude");

const body = $derived(text || placeholder);

/**
 * Keep a link click from also activating the card.
 *
 * `AnnotationCard` puts `onclick` + `tabindex` on its wrapper (it scrolls the
 * document to the annotation), so without this an anchor inside a rendered
 * reply both navigates AND scrolls the document out from under the user.
 */
function onBodyClick(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest("a")) event.stopPropagation();
}
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
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tandem-markdown ab-body" onclick={onBodyClick}>
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
