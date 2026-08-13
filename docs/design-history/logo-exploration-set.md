# The logo / banner exploration set (removed from the working tree)

`docs/assets/` once held ~107 files: four generations of logo exploration
(`logo-concept-*`, `logo-v2-*`, `logo-v3-*`, `logo-v4-*`), three of banner
exploration (`banner-v1-*`, `banner-v2-*`, `banner-v3-*`), a `_thumb.jpeg`
sibling for each, and `preview.html` — a hand-written contact sheet that
rendered them all. About 14 MB, none of it referenced by any doc, script or
component.

They were removed during the post-v0.22.1 documentation overhaul
(branch `docs/post-v0221-overhaul`). Nothing was lost: git history is where
abandoned exploration belongs, and it is still there.

## How to get them back

```sh
# every commit that deleted something under docs/assets/
git log --diff-filter=D --name-only -- docs/assets/

# restore one file from the commit before its deletion
git checkout <deleting-sha>^ -- docs/assets/logo-v4-cursors-connected.png

# or restore the whole set
git checkout <deleting-sha>^ -- docs/assets/
```

This file is deliberately phrased so the recovery criterion is answerable from
tracked files rather than from a commit SHA written down at deletion time — the
SHA is not knowable while writing the commit that contains this sentence, and a
pointer that can only be resolved by the person who wrote it is not a pointer.

## What survives, and why

| File | Kept because |
|---|---|
| `logotype-light.png`, `logotype-dark.png` | `README.md:3-4` embeds them in a `<picture>` block. |
| `logo.png` | `scripts/render-logotype.mjs` reads it as `MARK_PATH` to regenerate the two logotypes above. Deleting it breaks that script silently — nothing else references it, so a grep of `*.md` alone would have called it dead. |
| `logo.svg`, `banner.png`, `banner.svg` | The current mark and banner. Not embedded in the live README today, but they are the shipped artwork rather than exploration, and the README may reinstate a banner. |

The canonical logotype is not a file in this repo at all — it is a live
composition in the Tandem Design System (`preview/brand-logo.html`), which
`render-logotype.mjs` transcribes. See the note in that script before adjusting
any of the geometry.
