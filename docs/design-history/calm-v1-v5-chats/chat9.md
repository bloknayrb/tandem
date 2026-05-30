# Design-Repo Alignment

_Started 2026-05-03 21:08 UTC_

---

## User

identify any gaps between our current design and the repo. where do we need to update our design and where does the repo need to be updated in order to be ready for our design to be implemented?

## Assistant

Let me explore both the current design and the repo to do a thorough gap analysis.

_[tool: read_file]_

_[tool: local_ls]_

Let me do a deep dive into both the design file and the repo structure simultaneously.

_[tool: read_file]_

_[tool: local_ls]_

_[tool: local_ls]_

Let me read the key files in parallel to do a thorough comparison.

_[tool: read_file]_

_[tool: read_file]_

_[tool: local_read]_

_[tool: local_read]_

Let me read the remaining key files in parallel.

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

Let me read a few more key files to complete the picture.

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: read_file]_

Now I have a thorough picture of both sides. Let me compile the full gap analysis.

_[tool: snip]_

Now I have everything I need. Let me write the gap analysis document.

_[tool: write_file]_

_[tool: done]_

Here's the summary of what I found across all 8 areas:

---

**Design needs to update (5 items):**
- Adopt `--tandem-*` CSS token namespace — repo's is more complete
- Annotation card mock should reflect repo's actual type system (the promotion chain design doesn't match `type: "note" | "comment" | "suggestion"`)
- Settings dialog needs to reconcile with what's actually in the repo (it has more sections than the design shows)
- Status bar: decide whether the inline username input stays or moves to Settings only
- Reply thread expanded view needs to spec out whether reactions/status badges require a new data model

**Repo needs to implement (9 items, roughly priority order):**
1. **Selection mini-toolbar** — Tiptap `BubbleMenu` extension; design is fully spec'd
2. **Editor font token** — add `--tandem-editor-font-family`, wire to settings; tiny lift
3. **Tab file-type badge + dirty dot** — purely visual, data already exists
4. **Solo mode held-count in status bar** — held count already computed in `createModeGate`, just needs a prop + click handler
5. **Slash command menu** — new Tiptap extension
6. **Outline panel** — new panel component with H1–H3 parsing
7. **Paged docx layout** — `activeTab.format` is already the branch point
8. **Find/Replace bar** — Tiptap extension + overlay component
9. **Command palette ⌘K** — new component + action registry

**Both sides need alignment first (4 items — don't build until decided):**
- **Titlebar/toolbar merge** — blocking; requires a design decision on Tauri window decoration config before repo can act
- **Authorship gutter** — design shows a 2px left-margin thread; repo implements inline text coloring; these are fundamentally different visual approaches and need an alignment call
- **Diff/Apply-edit view** — design needs to clarify relationship to the existing `ApplyChangesButton` tracked-changes flow before repo builds anything
- **First-run onboarding** — existing `OnboardingTutorial.svelte` is a tutorial-annotations concept, not a wizard; decide if it's replaced or kept alongside

**Out of scope for now:** Share/Export (large backend work), Mobile layout (desktop not stable yet).
