# Track J — Words (docs, the shipped skill, product copy)

**Tier:** Sonnet builds, Opus reviews; Fable is not needed. **Decisions needed:** [H](../decisions.md)
(inbox ledger per session, or document the orchestrator-only rule) for one item of #1820.
**Do not hold the next minor for it**, but #1771, #1780, #1781 and #1782 are each a user following
instructions into a dead end and are cheap.

## Issues

| Issue | What | Area |
|---|---|---|
| [#1771](https://github.com/bloknayrb/tandem/issues/1771) | Replace the `author: "import"` recipe in the skill and `docs/workflows.md` with one that works (`type: "note"` is not visible to Claude; promoted imports are `author: "user"`), or add an `includeImports` that the tool description already half-promises. | [skill-plugin](../areas/skill-plugin.md) |
| [#1780](https://github.com/bloknayrb/tandem/issues/1780) | Detect the auth exit in the supervisor and show "sign in to Claude Code" with the command, not "Restart"; a troubleshooting entry. | [product](../areas/product.md) |
| [#1781](https://github.com/bloknayrb/tandem/issues/1781) | A path input in the browser build's open dialog (the server can open by path already), or the user guide stops promising one. | [product](../areas/product.md) |
| [#1782](https://github.com/bloknayrb/tandem/issues/1782) | `__tandem_ctrl__.json`, `.markdown`, `.corrupt.<ts>` in the recovery docs; a claims test that derives the names from `constants.ts`. | [docs](../areas/docs.md) |
| [#1814](https://github.com/bloknayrb/tandem/issues/1814) | Wizard headline keyed on presence, not `existing.length`. | [product](../areas/product.md) |
| [#1815](https://github.com/bloknayrb/tandem/issues/1815) | "One click connects" matches the Done step, or the Done step becomes one click. | [product](../areas/product.md) |
| [#1816](https://github.com/bloknayrb/tandem/issues/1816) | Save-failure toasts use the generic message with the errno in a details line, on loopback too. | [product](../areas/product.md) |
| [#1817](https://github.com/bloknayrb/tandem/issues/1817) | Push-path instructions gated on `isTauri`; the desktop text names what a desktop user can do. | [product](../areas/product.md) |
| [#1818](https://github.com/bloknayrb/tandem/issues/1818) | One word for restarting the server across Settings, the sidecar dialog and troubleshooting; delete the `tandem start --port` hint or add the flag. | [product](../areas/product.md) |
| [#1820](https://github.com/bloknayrb/tandem/issues/1820) | Hard Rule 4 rewritten for #1460 and the two tools it omits; name `tandem_annotationReply`; a rule against Edit/Write on an open file; the sub-agent ledger rule per decision H; the Lows (Hard Rule 2, the Error Recovery table, `anchor` not `selection`, `heldFromExport`). | [skill-plugin](../areas/skill-plugin.md) |
| [#1821](https://github.com/bloknayrb/tandem/issues/1821) | The forty verified drift items, one PR per doc; add a claims test under `tests/docs/` for anything that has drifted twice. | [docs](../areas/docs.md) and every area's "Doc drift" section |

## Rules that bite here

- **`skills/tandem/SKILL.md` is shipped to users**: bump its frontmatter `version` with every
  content change, or the installed copy never refreshes (#1790's lesson). The 25 skill tests pin
  the tool and parameter names it cites.
- `npm run check:links` checks every relative link and anchor repo-wide; run it before each PR.
- The eighteen `tests/docs/*-claims.test.ts` suites pin doc sentences against source; a doc edit
  that fixes drift may need the matching test updated, and a fix that changes source may break
  one. Run `npm test`, not only the doc.
- `docs/troubleshooting.md` is pinned against the harness port constants; never tell a user to
  occupy 4573, 4728 or 4729.
- A `#1234`-shaped token in prose is read as an issue reference by the token checker; an
  all-decimal hex in a colour position still reports.
- `welcome.md` is the tutorial's anchor text (`indexOf(targetText)`); changing a tutorial-targeted
  sentence needs `tutorial-annotations.ts` updated with it.

## Reviewer agents

None mandatory. `annotation-model-reviewer` on #1771 and #1820's reply rule, since both describe
what Claude may see.

## Done when

- `check:links` green, `npm test` green (claims tests updated where a sentence changed).
- The skill version is bumped once for the track, and `tandem setup --apply` under a scratch
  `HOME` installs the new version.
- Every #1821 item is ticked in the issue with its PR.
- A never-logged-in Claude Code produces a sign-in prompt in the product (smoke, any desktop).

## Status

_(empty)_
