import type { ChatMessage } from "../../shared/types";

/**
 * Picks out the Claude chat replies that arrived *live* (#2168): the ones a
 * notification, flash or chime may announce. Pure — no Svelte, no DOM — so the
 * ordering cases below are unit-testable.
 *
 * The hard part is not announcing history. These guards keep it out:
 *
 * - **The `synced` gate.** Yjs runs the chat observer BEFORE the provider emits
 *   `synced`, so the first message list a consumer sees is the whole history
 *   while the sync flag is still false. Nothing qualifies until `synced` is
 *   true.
 * - **The synchronous baseline.** It is the id list `yjsSync` captures inside
 *   the provider's `synced` callback (`ctrlInitialClaudeMessageIds`). It is
 *   NOT "whatever is present the first time we look": a reply that lands
 *   between `synced` and the first effect run is genuinely new and must not be
 *   swallowed into the baseline — the same rule `yjsSync` states for chat seen.
 * - **Re-seeding on every new `Y.Doc`.** A server restart means a new
 *   generation, and a new generation means the ctrl provider is rebuilt on a
 *   NEW doc, which syncs the full history again. So the known set is keyed on
 *   doc identity and re-seeded from that doc's baseline.
 * - **`known` is keyed on message id**, so a reply is announced at most once
 *   per doc, however often the list is re-observed.
 * - **A same-doc reconnect receives only the delta.** It keeps the doc and its
 *   state, so it correctly does not re-seed, and whatever it delivers is a
 *   reply this client has genuinely not seen — however late it arrives.
 * - **The dispatcher** (`chat-attention.ts`) then coalesces, rate-limits an
 *   away window to one announcement per 30 s, drops anything another window
 *   has already acknowledged (`isSeen`), and lets an active window only chime.
 *
 * `staleMs` is a backstop, not the mechanism, and it applies ONLY on the pass
 * that seeds a new doc: a reply older than that, outside the baseline, is
 * history that slipped past it (the server and client share one clock on
 * loopback, so the comparison is sound). On an already-seeded doc every unknown
 * reply is a live delta, so a reply that reaches Tandem late — after a lost
 * connection, say — still announces.
 */
export interface ReplyDetector {
  observe(input: {
    doc: object;
    synced: boolean;
    baselineIds: readonly string[];
    messages: readonly ChatMessage[];
    /** Ids still streaming (local-model collaborator, `Y_MAP_CHAT_STREAM`). */
    streamingIds: ReadonlySet<string>;
  }): ChatMessage[];
}

export function createReplyDetector(
  options: { now?: () => number; staleMs?: number } = {},
): ReplyDetector {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? 60_000;
  let seededFor: object | null = null;
  let known = new Set<string>();

  return {
    observe({ doc, synced, baselineIds, messages, streamingIds }) {
      if (!synced) return [];
      const seeding = seededFor !== doc;
      if (seeding) {
        seededFor = doc;
        known = new Set(baselineIds);
      }
      const fresh: ChatMessage[] = [];
      const cutoff = seeding ? now() - staleMs : Number.NEGATIVE_INFINITY;
      for (const message of messages) {
        if (message.author !== "claude" || known.has(message.id)) continue;
        // A row first seen while its `Y_MAP_CHAT_STREAM` sidecar is already
        // present: leave it unknown and announce it once the sidecar is gone.
        // This is NOT how a live streamed reply normally arrives. The
        // local-model collaborator mints the chat row at its FIRST flush via
        // `appendClaudeChatMessage` with no sidecar; only a LATER flush
        // (`updateClaudeChatMessage`) creates one. So a client watching live
        // announces a streamed reply at that first flush, preview = partial
        // text, and the sidecar arriving and finishing afterwards announces
        // nothing more (the id is already known). This branch matters only
        // when the row and its sidecar land together, e.g. a client that
        // reconnects mid-stream and receives both in one update.
        // Local-model streaming ships dark (BYO_MODELS_ENABLED). The partial
        // first-flush preview is accepted for now — revisit when BYO models
        // ship. (A held row is announced on a later, non-seeding pass, so its
        // timestamp frozen at the first flush no longer matters.)
        if (streamingIds.has(message.id)) continue;
        known.add(message.id);
        // The ack-before-work reply (#2165) means "working on it", which the
        // pickup row already shows. The answer that follows is the one to
        // announce.
        if (message.inProgress === true) continue;
        if (message.timestamp < cutoff) continue;
        fresh.push(message);
      }
      return fresh;
    },
  };
}
