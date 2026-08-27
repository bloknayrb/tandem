/**
 * The named Hocuspocus lifecycle seam (ADR-033).
 *
 * `provider.ts` cannot import the registry, the event queue or the
 * document-service — it would close a cycle in every direction — so it used to
 * expose four independent free setters and trust that somebody called each one
 * before bind. Four slots meant four things that could be half-installed, and
 * nothing named the set or made "installed" a single observable fact.
 *
 * This interface is that name. It is a **leaf**: it imports the Yjs types and
 * nothing else, so `provider.ts` can depend on it without any cycle, and the
 * concrete implementation is assembled at the composition root
 * (`bootstrap/hocuspocus-lifecycle.ts`, called from `index.ts`) where importing
 * the registry and the queue is already legal.
 */

import type * as Y from "yjs";

export interface HocuspocusLifecycle {
  /**
   * Whether Hocuspocus must keep a Y.Doc in its map after the last WebSocket
   * client disconnects. True for anything the registry still tracks as open,
   * and for `CTRL_ROOM`, which holds persistent chat history and is
   * deliberately not modelled as an open document (ADR-033).
   */
  shouldKeepDocument(name: string): boolean;

  /** A Y.Doc instance was replaced during `onLoadDocument`; rebind observers. */
  onDocSwapped(docName: string, newDoc: Y.Doc): void;

  /**
   * A Y.Doc was evicted from the map. This is NOT the mirror of
   * `onDocSwapped`: it detaches queue observers and must not touch the
   * durable-annotation file-sync context. That context is cleared
   * synchronously by an explicit document close, because this hook fires only
   * when Hocuspocus actually unloads a room — which, for anything
   * `shouldKeepDocument` retains, is never. Clearing it here would strand the
   * tombstone ledger of any document whose browser tab stays connected.
   */
  onDocUnloaded(docName: string): void;

  /**
   * The generation id every client must present as its Hocuspocus auth token,
   * or `null` while none has been minted (which the provider treats as
   * fail-closed: reject).
   *
   * **A method, deliberately, and non-optional.** A `string | null` *field*
   * would be captured at lifecycle-construction time — and this interface is
   * built at the composition root, which is exactly the place a future change
   * would move ahead of `writeGenerationId()`. It would then freeze at `null`
   * and reject every connection for the whole server run, logging the same
   * line as a legitimate stale-tab rejection. This is the server-side mirror
   * of the client's "tokens are pinned strings, never closures" rule, inverted:
   * here the *closure* is what keeps the read live.
   */
  expectedGenerationToken(): string | null;
}
