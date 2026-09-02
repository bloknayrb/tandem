# Area ledgers

One file per review area. Each holds the findings keyed by `file:line` (as of `3fb6408`), the
evidence tag, the verification status, the issue that carries the fix, the leads that were not
run, the doc drift folded into [#1821](https://github.com/bloknayrb/tandem/issues/1821), and what
was verified fine so nobody re-checks it. The ledgers are curated from the raw reports in
[`../raw/`](../raw/) and supersede them; where a ledger and a raw report disagree, the ledger is
the vetted reading. Status vocabulary is in the [top-level README](../README.md).

| Area | Reviewer | Raw source | H / M | Tracks |
|---|---|---|---|---|
| [ci-build](ci-build.md) | Fable (resumed) + Sonnet facts | `findings-ci-build.txt`, `gapfill-D.txt` | 4 / 3 | [I](../tracks/I-supply-chain.md) |
| [security](security.md) | Fable (resumed) + Sonnet + Opus probes | `findings-security.txt`, `gapfill-A.txt`, `gapfill-F.txt` | 0 / 1 | [F](../tracks/F-push-paths-and-cli.md), [K](../tracks/K-tests-and-lows.md) |
| [server-data](server-data.md) | Fable (resumed) + Opus experiments | `findings-server-data.txt`, `gapfill-E.txt` | 7 / 5 | [A](../tracks/A-stop-the-bleeding.md), [D](../tracks/D-word-and-markdown.md) |
| [server-runtime](server-runtime.md) | Fable (resumed) | `findings-server-runtime.txt` | 2 / 4 | [A](../tracks/A-stop-the-bleeding.md), [E](../tracks/E-desktop-lifecycle.md), [F](../tracks/F-push-paths-and-cli.md) |
| [shared-cli](shared-cli.md) | Fable (resumed) | `findings-shared-cli.txt` | 2 / 5 | [F](../tracks/F-push-paths-and-cli.md) |
| [tauri](tauri.md) | Fable (resumed), read-only | `findings-tauri.txt` | 3 / 4 | [E](../tracks/E-desktop-lifecycle.md) |
| [crdt](crdt.md) | Fable (resumed) + Opus experiments | `findings-crdt.txt`, `gapfill-E.txt` | 2 / 4 | [B](../tracks/B-anchors.md) |
| [client-editor](client-editor.md) | Fable (resumed) + Playwright lane | `findings-client-editor.txt`, `verify-client.txt` | 3 / 5 | [G](../tracks/G-client-editor.md) |
| [product](product.md) | Fable (resumed) | `findings-product.txt` | 4 (1 dup) / 7 | [J](../tracks/J-words.md), [C](../tracks/C-privacy-and-authority.md), [H](../tracks/H-the-flip.md) |
| [skill-plugin](skill-plugin.md) | Fable (resumed) + Sonnet | `findings-skill-plugin.txt`, `gapfill-C.txt` | 2 / 6 | [J](../tracks/J-words.md), [F](../tracks/F-push-paths-and-cli.md) |
| [docs](docs.md) | Fable (resumed) + Sonnet | `findings-docs.txt`, `gapfill-B.txt` | 1 (1 refuted) / 13 | [J](../tracks/J-words.md) |
| [tests](tests.md) | Fable (resumed) + Sonnet + Haiku | `findings-tests.txt`, `gapfill-C.txt`, `gapfill-G.txt` | 2 / 2 | [K](../tracks/K-tests-and-lows.md) |
| [client-ui](client-ui.md) | Opus (fresh) + Playwright lane | `findings-client-ui.txt`, `verify-client.txt` | 2 / 4 | [G](../tracks/G-client-editor.md) |
| [armed-license-gate](armed-license-gate.md) | Opus (fresh) + Opus probes | `findings-license-gate.txt`, `gapfill-F.txt` | 3 / 5 | [H](../tracks/H-the-flip.md) |
| [upgrade-path](upgrade-path.md) | Opus (fresh, over cap) | `findings-upgrade-path.txt` | 1 / 5 | [E](../tracks/E-desktop-lifecycle.md), [F](../tracks/F-push-paths-and-cli.md) |
| [infra-license-worker](infra-license-worker.md) | Opus (fresh) | `findings-infra-license-worker.txt` | 0 / 4 | [H](../tracks/H-the-flip.md) |
| [server-mcp](server-mcp.md) | Fable (fan-out, completed) | `report-A-server-mcp.md` | 2 / 6 | [A](../tracks/A-stop-the-bleeding.md), [C](../tracks/C-privacy-and-authority.md) |
| [annotations](annotations.md) | Fable (fan-out, completed) | `report-O-annotations.md` | 2 / 4 | [C](../tracks/C-privacy-and-authority.md) |

Counts are findings, not issues: several findings share an issue and a few issues span areas. The
Lows are in six batch issues (#1822 to #1826, plus the doc batch #1821) and each ledger's last
rows say which.

## How to use a ledger during a fix

1. Read the row. The `Where` column is where to put the breakpoint; the line numbers will have
   drifted, so search for the symbol.
2. Check the status. `Reproduced` means an experiment in [`../experiments/`](../experiments/README.md)
   already shows the failure: run it before and after. `Agent-reported` means nobody re-ran it: run
   it first, and if it does not reproduce, add a row to [refuted.md](../refuted.md) rather than
   deleting it.
3. Read the "Verified fine" section before widening the fix. Those checks were done so the fix
   does not need to redo them.
4. The issue holds the suggested fix. The ledger holds the mechanism and what else it touches.
