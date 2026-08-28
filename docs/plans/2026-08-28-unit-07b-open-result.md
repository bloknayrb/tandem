# Unit 7b — migrate the ADR-034 failure/result contract

**Branch:** `refactor/unit-07b-open-result` · **Base:** `origin/master` (`e3e94eb`)
**Predecessor:** Unit 7a (#1643 + #1645), which moved the pipeline into `src/server/documents/open.ts`.

## References — verified on this branch, not from the parent plan

The parent plan's 7b instruction cites `file-opener.ts:81-94` and `open.ts:50-52`. **Both are stale**: 7a moved everything.

| Thing | Now at |
|---|---|
| `OpenFileResult` (12 fields) | `src/server/documents/open.ts:110` |
| `buildResult` (emits `warnings`, estimates) | `open.ts:755-781` |
| `OpenResultKind`, `kindOfOpenResult` | `open.ts:826`, `open.ts:828-833` |
| `tandem_open` result handling | `src/server/mcp/document.ts:329-353` |
| MCP failure mapping | `document.ts:356-374` |
| HTTP failure mapping | `routes/_shared.ts:130-198` (`errorCodeToHttpStatus`, `errorCodeToLabel`) |
| `OpenDoc` (5 fields) | `documents/registry.ts:28-34` |

## What the inventory changed about this unit's shape

Three facts, each of which moves work off the plan or onto it.

**1. `kindOfOpenResult` and `OpenResultKind` have ZERO production consumers.** Only `tests/server/documents-open.test.ts` and a name reference in `tests/docs/documents-boundary.test.ts`. `open.ts:814-818` says so itself — it was written as a vocabulary for callers to adopt later. So "migrate callers with exhaustive switches" has almost no read-side burden: the booleans are read in exactly one production place.

**2. The booleans are read in one place, but SHIPPED from SIX.** Four are whole-object spreads: `document.ts:343` (`...result` into the MCP payload) and `routes/{open,upload,scratchpad}.ts` (`res.json({ data: result })`). **Two more are cherry-picks, and they are the ones a spec is likeliest to miss:** `document.ts:391-395` (`tandem_scratchpad` takes `documentId`, `fileName`, `format`) and `convert.ts:187-191` (takes `documentId`, `fileName`). Every field of `OpenFileResult` — including `warnings`, `tokenEstimate` and `pageEstimate` — is on the MCP and HTTP wire today. **Any field the union drops is a silent wire change.**

*And "no production code reads them" is not a reason to relax this.* Nothing in `src/client` or `src-tauri` reads the estimates or warnings off the wire — but the MCP payload's consumer is **the calling model**, which no grep of this repo can see. Unread-by-us is not unread. Treat every field as load-bearing.

**3. The user-facing message set is FIVE branches, not four.** `document.ts:345-352`:

```
forceReloaded → alreadyOpen → restoredFromSession → readOnly → default
```

The parent plan's point 1 asks whether `restored` gets its own arm. The real gap is wider: **`readOnly` is a fifth discriminator the four-kind vocabulary does not name at all.** A `fresh` open produces two different messages depending on it. Any union claiming to be exhaustive over "what the user is told" must either carry `readOnly` on the success arm or state that the split lives outside the union.

Note also that this chain is a **second, independent copy** of `kindOfOpenResult`'s precedence (`open.ts:829-832`). Two copies, no test tying them together — so today they agree by inspection only.

## Plan

### §1 Pin the precedence BEFORE promoting it to a discriminator

*Problem:* today's four booleans are disjoint by accident, not by type — the force branch hardcodes `restoredFromSession: false` (`open.ts:180`) and `buildResult` hardcodes `alreadyOpen: false, forceReloaded: false` (`open.ts:778-779`). Only `kindOfOpenResult`'s ordering makes the mapping total. A future restored-and-already-open path would silently report `already-open`.

*Fix:* before any type change, add a spec that feeds `kindOfOpenResult` **every** boolean combination, including the impossible ones, and pins the resolved kind. Then add a spec tying `document.ts`'s message chain to the same precedence, so the two copies cannot drift apart silently. Both must go red under a reordering — mutation-prove that, don't assume it.

### §2 Decide the arms against the message set, not the boolean set

*Problem:* a four-arm union derived from the booleans cannot express the `readOnly` split, so migrating the message chain onto it would lose a user-visible distinction — which this unit's own instruction forbids.

*Fix:* arms are `fresh | restored | already-open | force-reloaded`, with `readOnly` carried as a **field on the arm**, not as an arm. Record explicitly in the ADR that the message set is arms × `readOnly`.

*What that does NOT buy, because review made the point and it is worth keeping:* a field is optional to consult. Nothing forces a `switch (result.kind)` to branch on `readOnly` inside each case, so the drop this section exists to prevent stays reproducible — the field relocates the hazard, it does not close it. **The eight-arm `kind × readOnly` union WOULD close it at compile time.** It is rejected because it doubles the arms to express one boolean and makes the wire projection worse, not because it is wrong. The compensating control is a spec over the full `(kind, readOnly)` cross product against the **message builder**, not only against `kindOfOpenResult` — §1.

*And a live consequence of the current chain, which this unit should record rather than silently preserve:* `document.ts:344-352` is a chained ternary, so the `readOnly` branch is reachable **only when the other three are false**. A restored, already-open or force-reloaded document that is also read-only therefore gets a message that never mentions read-only at all — the View-Changelog-on-restore path (`openFromRestore`, `open.ts:786-805`, #1591). Characterize it in this PR; fixing the wording is a behaviour change and belongs in its own.

### §2a Name it for what it is

*Problem:* a union named `OpenResult` reads at every call site as "the result of opening a file". With §4 keeping failures thrown, it is really "the result of an open call that did not throw", and a `switch` over it is not total over what `openFromDisk` can do.

*Fix:* name it **`OpenSuccess`**. TypeScript has no checked exceptions to make this honest structurally; the name is the one free signal available, and it costs nothing.

### §2b Entry points return only the arms they can produce

*Problem:* `openFromUpload` and `openScratchpad` can produce exactly one kind. Verified: `alreadyOpen: true` is set in exactly one place (`open.ts:550`, and `open.ts:509` says so in as many words); both entry points route through `buildResult`, which hardcodes `alreadyOpen: false, forceReloaded: false` (`open.ts:777-778`), and upload passes `restoredFromSession: false` (`open.ts:376`). Typing them as the full union forces every caller writing an exhaustive switch to supply three provably dead branches — or to cast past it. The same permissiveness admits `{ kind: "restored", source: "upload" }`, which no path produces.

*Fix:* `openFromUpload` and `openScratchpad` return `Extract<OpenSuccess, { kind: "fresh" }>` behind a named alias. One line each. It also converts any future change that lets upload reach a second kind — content-hash dedup landing on `already-open`, say — into a visible signature change rather than a silent new runtime path a permissive type already allowed.

This is the same argument `openFromRestore`'s own doc comment makes for its `Pick` parameter (`open.ts:793-805`); the plan was inconsistent in not extending it to the result.

### §3 Success arms carry warnings and the estimates

*Problem:* `buildResult` emits large/very-large warnings on **success** paths (`open.ts:764-771`). A union whose only warning-carrying arm is a failure arm drops them, along with `format`, `fileName`, `tokenEstimate` and `pageEstimate` — none of which `OpenDoc` has.

*Fix:* every success arm carries the full success payload. `OpenDoc` is not the union's payload type and must not be mistaken for it.

*The warning spec must use a real large document, not a stub.* `buildResult` computes the estimates and the large/very-large warnings from `extractText(doc)` (`open.ts:756-758`), and every current call site reaches it strictly **after** content is loaded and the store is wired. That ordering is what makes the numbers correct, and nothing states it. Assembling the union progressively — fields added as they become known, rather than at the final return — would reorder that read ahead of population, silently zeroing the estimates and suppressing both warnings. A spec built on an empty or stubbed Y.Doc cannot see it, because zero is what a stub yields anyway. Assert against a document whose real extracted length crosses each threshold.

*Do not oversell what the union then is.* If every arm carries identical fields, the type is structurally `{ kind } & CommonPayload` — isomorphic to today's interface plus a `kind`. No arm-specific narrowing exists, and accessing `pageEstimate` will never require checking `kind` first. Inventing arm-specific payloads the domain does not have would be worse, so this is the honest shape — but it means **the win is not exhaustiveness.** The win is that `kind` becomes computed once at construction instead of re-derived by each reader, which is what kills the duplicated precedence in Risk 3. Describe it that way in the PR; a "tagged union" framing would claim a compile-time guarantee this design does not deliver.

### §4 Failures stay exceptional in 7b

*Problem:* the tempting move is a `failed` arm. But failures are currently **thrown**, and their externally visible mapping is real and asymmetric: MCP maps `INVALID_PATH` → `FILE_NOT_FOUND` while HTTP maps it → `400 BAD_REQUEST`; `UNSUPPORTED_FORMAT`/`FILE_TOO_LARGE` collapse to `FORMAT_ERROR` on MCP but split 400/413 on HTTP; `convert.ts:189-201` rewraps an open failure as `OPEN_FAILED`. Converting throw-sites to a returned arm rewrites all of that in the same PR that introduces the union.

*Fix:* **this PR changes the SUCCESS contract only.** Failures keep throwing; the two mapping tables are untouched. A returned `OpenFailure` is 7b-part-2 or 7c, and gets its own characterization. State this in the PR so "exhaustive" is not read as "covers failure". §2a's naming carries the same message at every call site.

*The arm must be decided AFTER the mutation it describes, never before.* The force branch (`open.ts:184-214`) calls `clearAndReload`, which wipes the open document's content and annotations, and only then wires the store and builds a `forceReloaded: true` result. If wiring throws after the wipe, the document is left cleared with no result returned — CLAUDE.md's own "`force: true` clears annotations, awareness and content in one transaction. Never mid-review." A union refactor invites deciding the discriminant early, where it reads more cleanly; doing so would decouple *which arm we claim* from *whether the mutation that arm names actually completed*. Deferring the failure arm must not become a licence to hoist the success one.

*One outcome the union will still not express, and the ADR must say so.* "Opened successfully, but flagged for external-conflict resolution" rides a Y.Map side-channel (`flagExternalConflict`, `open.ts:98`; the `Y_MAP_EXTERNAL_CONFLICT` clearing at `open.ts:746-749`) entirely outside the result type. That is pre-existing and not this unit's to fix, but a unit whose stated job is to characterize the success contract precisely must record it — otherwise the next reader takes the union for the complete picture of what an open can produce, which it is not.

### §5 The wire shape does not change

*Problem:* six sites put the payload on the wire. A union that changes the JSON breaks the MCP tool response and three `/api` bodies at once, with no test failing on the client side.

*Fix:* the union is the **internal** contract. Each adapter projects it back to today's flat `OpenFileResult` JSON at the boundary. Add a spec asserting the projected object is key-for-key identical to what master emits for each kind — generated by calling the real entry points, not hand-built, because an input I construct myself can only confirm my own model.

*Enumerate all six, not the four spreads.* `document.ts:343`, `routes/open.ts:23`, `routes/upload.ts:24`, `routes/scratchpad.ts:70`, **plus** `document.ts:391-395` and `convert.ts:187-191`. The first draft of this plan said "four", and a spec scoped to the four whole-object spreads would have left both cherry-picks unguarded — which is precisely where a correspondence bug hides, since a cherry-pick keeps compiling when the field it names changes meaning rather than name.

*Route the projection through ONE shared projector* that all six import. Six independent projections are six chances to drift, and the spec would then be pinning the projector rather than what each site actually emits.

### §6 Verification

- Full `npm test`, `npm run typecheck`, `npm run typecheck:tests`, `cargo test`.
- Mutation battery with required-GREEN probes on: precedence reordering, a dropped `readOnly`, a dropped `warnings`, and a renamed wire key.
- `tests/docs/documents-boundary.test.ts` references `kindOfOpenResult` by name — check the guard still binds after the rename.

## Risks

1. **The wire projection is the whole safety argument, and it is the easiest thing to get subtly wrong.** A key-for-key spec built from the real entry points is the only control that catches it; a hand-built fixture would only confirm my own model.
2. **`kindOfOpenResult` having no production consumers means the type change is nearly free — which is exactly when scope creeps** into the failure contract. §4 is the line.
3. Two precedence copies exist (§1). If the tying spec is skipped, this PR makes drift more likely, not less, by adding a third representation.
