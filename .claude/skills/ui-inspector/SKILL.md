---
name: ui-inspector
description: Resolve a durable @ui_ reference from the Tandem desktop element picker into source, metadata and screenshots. Use when a request names @ui_…, ui_…, "the element I picked", "this button/panel", or an inspector screenshot.
---

# UI inspector references

Bryan picked an element in the running Tandem desktop app and it was recorded as
`@ui_<ULID>` — DOM + ARIA metadata, ranked locators, the `.svelte` source
location, a full native window screenshot and an element crop.

**Use the recorded reference. Never infer the element from the description when
an `@ui_` id is available.** The whole point of the reference is that it removes
the guess; a "nearby" element is a wrong answer that looks right.

## Prerequisites (check these before blaming the CLI)

The picker only exists in a dev build with the cargo feature on:

```sh
cargo tauri dev --features ui-inspector
```

Then `Ctrl+Shift+C` (or `ui-inspector pick`) selects an element. `ui-inspector`
is a per-machine tool, not a repo dependency — `cargo install tauri-ui-inspector`
if the command is missing.

Three failure modes look identical from the CLI (a timeout, or exit 3):

| Symptom | Cause |
|---|---|
| exit 3, no `.ui-inspector/run/instance.json` | app not running, or built without `--features ui-inspector` |
| bridge installed, every capture rejected | cargo feature off — the ACL has no `ui-inspector:default` grant. The WebView console says so |
| `pick` hangs to timeout | wrong `--window`, or another pick/resolve is already active |

The store is pinned to the **repo root** (`<repo>/.ui-inspector/`), so the CLI
works from anywhere in the tree — it walks *up* looking for a directory that
contains `.ui-inspector`. Only pass `--project <repo>` when running from outside
the checkout entirely.

## Resolve the reference

```sh
ui-inspector get @ui_01... --json
```

`--json` writes exactly one JSON value to stdout; diagnostics go to stderr.
Never scrape the human-readable format.

Read these fields first: `summary`, `element.role`, `element.accessibleName`,
`source.location`, `source.component`, `element.locators`, `screenshots.element`,
`screenshots.window`, `dom.ancestry`.

Exit 2 means the reference is absent — **stop and ask** for the right project or
id. Do not substitute a similar reference.

## Inspect the pixels

```sh
ui-inspector screenshot @ui_01... --json
```

Read `element.png` before editing. Read `window.png` when the request is about
spacing, alignment, layering or consistency with neighbouring controls — Tandem's
rail/panel invariants are usually a *relationship* between elements, not a
property of one.

If the screenshot fields are null, work from the structured metadata and say
plainly that pixels were unavailable.

**Never publish or upload the screenshots or the reference JSON.** They are
pictures of whatever document Bryan had open. `redactText` is on for the JSON
record; nothing can redact pixels. `.ui-inspector/` is gitignored — keep it that
way, and never attach one of these images to an issue or PR.

## Locate the source

Open `source.location.file` at the recorded line and column. Confirm the
component, role, accessible name and local markup all agree with the reference
before editing.

Source metadata comes from Svelte 5 dev metadata via the Vite dev server, so it
is present for `cargo tauri dev` and absent in a bundled build. When it is
missing, fall back in this order:

1. `data-testid` — the strongest locator, and in Tandem it is a **contract**
   (Critical Rule 7). If the element has one it is in
   `tests/design-system-impl/__snapshots__/testid-set.snap.txt`; grep there to
   find every consumer before you touch it, and never rename one without
   regenerating that snapshot.
2. Unique role + accessible name.
3. A stable DOM id or attribute.
4. The generated CSS selector — supporting evidence only.
5. A structural DOM path or a text match is **not** proof you found the right
   source. Say you are unsure instead.

## Edit and verify

Make the smallest change that answers the request, then honour the house rules
the picker cannot see:

- A colour or spacing fix uses `var(--tandem-*)` or `src/client/utils/colors.ts`,
  never a raw hex or rgba. Run `npm run check:tokens`.
- `.svelte` changes: `npm run typecheck` (it includes
  `svelte-check --fail-on-warnings`) and `npm test`; add `npm run test:e2e` for
  anything structural.
- Never write `$state` synchronously from a Tiptap event handler — bridge through
  `createCoalescingTick`.

With the app still running, confirm the element still resolves:

```sh
ui-inspector resolve @ui_01... --json
```

Exit 5 means it no longer resolves *exactly*. That is a signal to inspect what
the edit changed about the locators, not to accept a near match.

For a visual before/after, ask Bryan to pick a fresh reference after the HMR
reload and compare the two element crops.

## Other CLI subcommands

```text
ui-inspector last | list | delete <id> | clear
```

## Redaction

Honour the redaction markers in the JSON. Never reconstruct a password, token,
form value or hidden text from surrounding data.
