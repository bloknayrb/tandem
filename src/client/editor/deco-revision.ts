import type { Transaction } from "@tiptap/pm/state";
import { yCursorPluginKey, ySyncPluginKey } from "@tiptap/y-tiptap";
import { annotationPluginKey } from "./extensions/annotation";
import { authorshipPluginKey } from "./extensions/authorship";
import { awarenessPluginKey } from "./extensions/awareness";

/**
 * Should a transaction be treated as "the annotation decorations may have been
 * rebuilt"? (#1963)
 *
 * `Editor.svelte`'s pulse effect writes `.tandem-annotation-active` onto DOM
 * nodes the annotation decoration plugin produced, so it has to re-run whenever
 * those spans are re-created — which neither `editor` nor `activeAnnotationId`
 * reports. The counter it reads is bumped from the editor's `transaction`
 * event, and `transaction` fires on every cursor move, hence this gate:
 *
 * - `docChanged` is the ordinary rebuild;
 * - the `ySyncPluginKey` meta is the #1669 remote-sync doc replacement (the
 *   annotation plugin keys on the same meta for the same reason);
 * - the `annotationPluginKey` meta is the plugin's own explicit rebuild signal.
 *
 * The last three keys are NOT decoration-rebuild signals of the annotation
 * plugin at all, and are here for a reason that is invisible from their names:
 * `.tandem-annotation-active` is a class ProseMirror does not know about,
 * merged into the `class` attribute it writes on the `[data-annotation-id]`
 * span. ANY decoration-bearing plugin that redraws that span rewrites the
 * attribute and strips the pulse — so the set this gate has to cover is "every
 * plugin whose redraw can repaint an annotation span", not "every plugin that
 * rebuilds annotation decorations". `yCursorPluginKey` (remote caret),
 * `tandemAwareness` and `tandemAuthorship` all dispatch a metadata-only,
 * `docChanged: false` transaction a few milliseconds AFTER the y-sync doc
 * replacement — which is the measured shape of #1963's surviving half: the
 * pulse was re-applied on the y-sync bump and stripped again immediately, with
 * nothing left to re-apply it. Adding a fourth such plugin means adding it
 * here.
 *
 * The cost of the widening is one extra `querySelectorAll` pass per remote
 * awareness/authorship tick, coalesced by `createCoalescingTick` — cursor-move
 * churn is still suppressed, because a local selection change carries none of
 * these metas.
 *
 * `!!` rather than `=== true`: the annotation meta is typed
 * `AnnotationToggleMeta | true | undefined` and the decoration-visibility
 * toggle dispatches the object form, so an identity test would silently drop
 * every toggle. The same holds for the other three, which carry object or
 * boolean payloads depending on the dispatch site.
 *
 * Its own module so it is unit-testable without mounting a Tiptap editor.
 */
export function shouldBumpDecoRevision(tr: Transaction): boolean {
  return (
    tr.docChanged ||
    !!tr.getMeta(ySyncPluginKey) ||
    !!tr.getMeta(annotationPluginKey) ||
    !!tr.getMeta(yCursorPluginKey) ||
    !!tr.getMeta(awarenessPluginKey) ||
    !!tr.getMeta(authorshipPluginKey)
  );
}
