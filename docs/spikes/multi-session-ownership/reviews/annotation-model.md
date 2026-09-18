# Annotation-model review (annotation-model-reviewer), checked against master c6533cb0

1. BLOCKING (Critical) — §5.3's D7 emission can't be built as described, and its safety claim is false.
   - Every MCP annotation write is `withMcp` (lifecycle.ts:967). The observer factory returns early on `shouldSkipChannel` (observers/factory.ts:71), so an observer arm never sees a Claude create.
   - The only ways to make it fire are re-tagging as `withBrowser` (wrong helper, Rule 2) or calling `pushEvent` directly, which is module-private (queue.ts:227).
   - `isUserPrivacyHeld` is NOT author-gated for `annotation:created`; only `annotation:reply` checks the author (queue.ts:209-213).
   - `isUnansweredAsk` counts every `annotation:created` (delivery-state.ts:122-124).
   - Failure: a Claude suggestion becomes a recorded unanswered user ask (recordWakeForward, queue.ts:334). /health reports awaiting-poll for something no user asked, and the owner's poll can't close it, because userActions admits only user-authored comments. The unscoped shim and plugin monitor push it to every session, including the author, and the channel instructions tell Claude to act on it: a self-wake loop.
   - Fix: take option B (refuse). If A survives, it needs its own event type outside `isUnansweredAsk` and `isUserPrivacyHeld`.

2. BLOCKING (High) — the ownership check can't sit where §3.7 puts it, and "caller authored" has nothing to key on.
   - The lifecycle functions receive only (id, ydoc, map, …): no docId, no caller token (lifecycle.ts:891-897, 1007-1013, 1408-1414, 1454-1459).
   - `author` is "claude" for every session; no per-session attribution is stored.
   - Current rules:
     - dismiss is open to user comments (lifecycle.ts:950-951)
     - `removeForClaude` has no author check (1468-1470)
     - edit and reply already refuse non-Claude authors (1031, 1444)
   - Failure:
     - "caller authored AND owns doc" takes away the owner's existing dismiss/remove of user comments, an unnamed regression.
     - A non-owner's allowed comment can never be withdrawn or edited by that non-owner.
     - A stored authorship field would put token-derived data in a Y.Map, contradicting §3.2.
   - Fix: make ownership doc-level only and check it in the handler before any lookup (a doc-level refusal leaks nothing about a record, so the ordering constraint is unnecessary). Drop the per-record authorship half, or design attribution explicitly. Never guard `addUserReply` or `removeAnnotationRecord`.

3. High — `tandem_checkInbox` counts as a "read", but it writes the ledger and marks chat read (awareness.ts:461-499; license table calls it an ungated read, license-gate-coverage.test.ts:92). With a foreign documentId it silently consumes the owner's items.
   - Fix: refuse a foreign documentId with NOT_OWNER before collecting, or return items without writing the ledger.

4. High — takeover loses what the old owner already surfaced. `surfacedIds` and `replySurfacedIds` are keyed docId:itemId with no token (awareness.ts:57,71,74-76); chat `read: true` is stored in the record (:497).
   - Fix: key the ledgers per token, or clear a doc's entries on transfer (a duplicate beats a loss). State the chat residual.

5. High — delivery-state rounds become false. `resolveDeliveryRound` is process-global and closes on any poll (awareness.ts:431, delivery-state.ts:164-179), so B's poll closes a round only A can collect. The per-subscriber predicate adds a second case: `recordWakeForward` and `trackPayloadId` are gated on `externalSubscribers.size > 0` (queue.ts:290,334), so an event every predicate drops still records a forward and stamps alreadyPushed.
   - Fix: make rounds per doc or per token, resolve them only when the poller's scope covers the ask, and evaluate predicates before the tracking conjuncts.

6. Medium — annotations on unowned docs are neither delivered nor woken. After a restart every doc is unowned. §3.4 gives unowned chat a first-poller path, but not annotations; no ?doc= socket exists and the supervisor predicate drops them. Also, a caller owning zero docs gets DOCUMENT_REQUIRED and can never be "first poller".
   - Fix: define unowned-annotation routing explicitly.

7. Medium — the supervisor predicate must read ownership live (a lookup function, not a set captured at subscribe, supervisor.ts:141).

8. Medium — D1 conflict: "non-owner may comment on any doc" (§3.7) is a non-owner response. Bryan must decide.

9. Low — the owner label:
   - `withInternal` is correct (registry.ts:167,181).
   - A single Y_MAP_DOC_OWNER_LABEL key can't hold per-doc labels; put the label on `toDocListEntry` instead, which also adds no new ymap key.
   - The claim and takeover paths need a registry composite (e.g. setOwnerAndPublish), not an ad-hoc broadcastOpenDocs() (docblock :154-157).

10. Info — handled adequately:
   - Refusing non-owners on force-open (#1813), restore and applyChanges is right; non-owner comments survive force-open via the envelope re-merge.
   - Doc-less Solo release is consistent (queue.ts:484-496).
   - Word imports: nothing ownership-specific beyond #6.
   - Verified: Claude creates emit nothing today (observers/annotations.ts:110,158-180).
