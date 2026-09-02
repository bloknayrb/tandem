# Track H — The flip (licensing, armed)

**Tier:** Opus builds; Fable reviews the flip checklist. **Decisions needed:** 5 is taken (soft
clock stays; `""` treated as unparseable); [F](../decisions.md) (restricted-mode asymmetry) gates
part of #1788; [D](../decisions.md) (npm bypass, track E) gates the last item. **Release
relation:** none until the flip; the gate is dark and must stay byte-identical, so **every change
here lands behind `LICENSE_GATE_ENABLED` / `TANDEM_LICENSE_GATE=1` and is verified with the
armed scratch server**, never in shipped behaviour.

## Issues

| Issue | What | Area |
|---|---|---|
| [#1785](https://github.com/bloknayrb/tandem/issues/1785) | Two consts flip, not one (`tsup.config.ts` and `lib.rs:171`), and the flip checklist says so; the un-entitled updater branch must not fall back to the public `latest.json` (neutralise the `tauri.conf.json` endpoint at the flip). | [armed-license-gate](../areas/armed-license-gate.md), [infra](../areas/infra-license-worker.md) |
| [#1786](https://github.com/bloknayrb/tandem/issues/1786) | The update worker returns `reason` (or a header) and the client shows "no update served because…"; `[observability]` in both `wrangler.toml`s and `ALERT_*` wiring on the update worker. | [armed-license-gate](../areas/armed-license-gate.md), [infra](../areas/infra-license-worker.md) |
| [#1788](https://github.com/bloknayrb/tandem/issues/1788) | `firstRunAt: ""` fails closed like an unparseable value (decision 5); `POST /api/mode/release` joins the gated set in both halves; a fixture with an expired `trial.json` so armed-and-restricted is exercised; the Surface A poll's empty catch; decision F on resolve-while-restricted. | [armed-license-gate](../areas/armed-license-gate.md) |
| [#1789](https://github.com/bloknayrb/tandem/issues/1789) | Desktop activation without the CLI (a file picker or paste field, since no `.license` association exists); `TANDEM_APP_DATA_DIR` documented as relocating the license; a dated key-rotation issue. | [armed-license-gate](../areas/armed-license-gate.md) |
| [#1793](https://github.com/bloknayrb/tandem/issues/1793) | Pre-mint guard on `RESEND_FROM`; `revoke()` reads the order id from the right field, with a sandbox fixture; config-stage 503s alertable. | [infra](../areas/infra-license-worker.md) |
| [#1819](https://github.com/bloknayrb/tandem/issues/1819) | Clamp `daysRemaining`; an ended-window branch in the up-to-date dialog. | [product](../areas/product.md) |

## How to verify anything here

- `experiments/server-probes/run.sh` starts a scratch server on 4918/4919 with the gate **armed**
  and an isolated app-data dir; the curl one-liners in `raw/gapfill-F.txt` are the probes.
- `TANDEM_LICENSE_GATE=1 npx vitest run` runs the whole suite armed (10,140 passed at review
  time). Add the expired-`trial.json` fixture so restricted mode is exercised by it.
- The workers' 78 tests live under `tests/server` and run in `check`.
- Critical Rule 9 and the gated-set list in `docs/licensing-explained.md` are the review for the
  `/api` half; `tests/server/license-gate-coverage.test.ts` is the MCP half (and #1784 fixes its
  regex hole first: do that in track K before relying on it here).

## Order

1. #1788's `firstRunAt` edit and the `mode/release` gating: small and decided.
2. #1785: the flip checklist, then the updater fallback.
3. #1793 and #1786 together (both are worker changes; deploy once).
4. #1789 and #1819: copy and UX.
5. The §8 launch checklist in `docs/licensing-operations.md` gains the sandbox-fixture and
   Ed25519 lines from the infra ledger.

## Reviewer agents

`security-reviewer` on everything (the gate is the product's only revenue control);
`annotation-model-reviewer` on the `mode/release` gating (it touches `heldInSolo` markers).

## Done when

- With the gate armed and the trial expired, the browser room is read-only, every gated tool
  returns `LICENSE_REQUIRED`, and `POST /api/mode/release` does too.
- `firstRunAt: ""` yields restricted, not a perpetual trial.
- The flip checklist names both consts and the `tauri.conf.json` endpoint.
- A user whose update window has ended sees why no update is served.
- The workers' tests include a refund payload fixture from the Polar sandbox.

## Status

_(empty)_
