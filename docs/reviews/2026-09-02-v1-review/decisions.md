# Decisions

Tracked in [#1827](https://github.com/bloknayrb/tandem/issues/1827). Record answers there and in
the issue each item names; this file is the snapshot at 2026-09-02.

## Taken (Bryan, 2026-09-02)

| # | Decision | Recorded in | Unblocks |
|---|---|---|---|
| 1 | `tandem_restoreBackup()` with no argument on a `.docx` with no snapshot from this run **lists** the sidecar as an entry and never restores; the path honours `readOnly`. | #1768 | Track A |
| 2 | `.html` opens **read-only**; annotations still work; `.html` stays out of both save sets for v1, so `saveDocumentToDisk` keeps refusing it — a policy exclusion, not a missing adapter (it routes to `plaintextAdapter`, whose `save` is the one `.txt` uses). | #1798 | Track A |
| 3 | Claude may **dismiss or withdraw** its own annotations, never **accept**. Claude-resolved records leave `userResponses` and `applyChanges`. The MCP accept path then applies only to user-authored records and must either apply `suggestedText` or refuse. | #1770 | Track C |
| 4 | `tandem_editAnnotation` and `tandem_annotationReply` are scoped to annotations **Claude authored**. | #1770 | Track C |
| 5 | The soft trial clock stays (ADR-040 §3). The falsy-`firstRunAt` reset path is closed as a two-byte edit; an empty string is treated like an unparseable value. | #1788 | Track H |

Also agreed: fix work waits until the review is complete (it is); the repo rules "never
abbreviate steps" and "fix rather than file" were deferred for the review only.

## Open

Each entry has enough context to answer without reading code.

**A. Are Obsidian vaults in scope for v1?** (#1753) `[[wikilinks]]` and `![[embeds]]` are escaped
to `\[[…]]` on save, and user backslash escapes are stripped. If vaults are in scope the markdown
pipeline needs a wikilink node (remark-wiki-link or a custom mdast node) and a round-trip test; if
not, the README should say so and Tandem should warn once when it opens a file containing `[[`.
Gates track D.

**B. Is `tandem_applyChanges` a v1 surface?** (#1754) On real Word documents every `w:tab`,
`w:br` and `w:sym` makes the walker throw "Flat text mismatch", and empty paragraphs and page
breaks shift comment anchors. Options: fix the walker to the mammoth contract before v1 (track D,
the largest single item); ship it marked experimental in the tool description and the skill; or
hide it behind a flag. Gates track D.

**C. Should force-open and source-view commit keep the on-disk annotation envelope?** (#1813)
Both call `store.clear()`, which unlinks the envelope, including personal notes, with no backup.
Option 1: keep the behaviour, document it, take a `.bak` first. Option 2: clear only the in-memory
map and let the next open re-anchor from `textSnapshot`. Option 2 is safer for source-view commit,
where the user expects annotations to survive where the text still matches.

**D. What to do about `npm i -g tandem-editor@0.24.1` as a post-v1.0 gate bypass?** (#1787) The
npm package and the desktop share one app-data directory and pre-gate versions stay on the
registry forever. Options: `npm deprecate` the pre-1.0 range with a message (does not remove
them); make the desktop refuse to share its data dir with an older server; accept and document.
Gates the last item of track H.

**E. Does the Cowork firewall rule alone make :3479 reachable from the VM?** README:191-192
implies it does via `host.docker.internal`, but `TANDEM_BIND_HOST` is never auto-set. Hardware
question; one line in [smoke-lines.md](smoke-lines.md). If the answer is no, the README
instruction is incomplete.

**F. Is "Claude can resolve but the human cannot edit" the intended shape of restricted mode?**
(#1788) With the gate armed and the trial expired, Surface A makes the room read-only for the
browser while `tandem_resolveAnnotation` stays ungated. Gates part of track H.

**G. Should the release skill refuse to publish an RC tag as latest?** (#1748) `prerelease: false`
plus `--latest` means an RC tag auto-updates every desktop user. Either the skill refuses a tag
containing `-`, or RCs are never tagged on this repo. Affects track I and the release gate.

**H. Key the inbox ledger per Claude session, or document that only the orchestrator polls?**
(#1820 item 4) `surfacedIds` is process-global; a sub-agent calling `tandem_checkInbox` consumes
items the orchestrator never sees. `X-Claude-Session-Id` is optional, so per-session keying needs
a fallback. Affects track J.
