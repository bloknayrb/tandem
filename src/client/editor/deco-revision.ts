import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { annotationPluginKey } from "./extensions/annotation";

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
 * `!!` rather than `=== true`: the annotation meta is typed
 * `AnnotationToggleMeta | true | undefined` and the decoration-visibility
 * toggle dispatches the object form, so an identity test would silently drop
 * every toggle.
 *
 * Its own module so it is unit-testable without mounting a Tiptap editor.
 */
export function shouldBumpDecoRevision(tr: Transaction): boolean {
  return tr.docChanged || !!tr.getMeta(ySyncPluginKey) || !!tr.getMeta(annotationPluginKey);
}
