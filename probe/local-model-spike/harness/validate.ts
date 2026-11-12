/**
 * Start-up validation of the scenario bank (brief R2 "Judged by").
 *
 * Every gold anchor, acceptable anchor, selection and quote target is put
 * through the PRODUCT'S OWN dispatch on a scratch document with editing
 * allowed — `propose_replacement` for a replacement's span, `comment_on_quote`
 * for everything else — the route a model's quote takes — not through a
 * separate resolver. A run refuses to start when any of them fails.
 */
import * as Y from "yjs";

import { loadMarkdown } from "../../../src/server/file-io/markdown.js";
import { dispatch } from "../../../src/server/local-model/index.js";
import { fixtureFor } from "./scenarios/index.js";
import type { AnchorRef, Scenario } from "./scenarios/types.js";

/** Which tool a model would quote this anchor through. A replacement's span
 *  takes the suggestion arm, whose heading screen is stricter (CLAUDE.md rule 6). */
type Via = "comment_on_quote" | "propose_replacement";

function anchorsOf(s: Scenario): { what: string; ref: AnchorRef; via: Via }[] {
  const out: { what: string; ref: AnchorRef; via?: Via }[] = [];
  const e = s.expect;
  if (s.selectedText !== undefined) out.push({ what: "selection", ref: { quoted_text: s.selectedText } });
  if (e.kind === "offer-change" || e.kind === "offer-comment") {
    out.push({ what: "target", ref: { quoted_text: e.target } });
  }
  if (e.kind === "annotation") {
    const via: Via = e.operation === "replacement" ? "propose_replacement" : "comment_on_quote";
    out.push({ what: "gold anchor", ref: e.target, via });
    for (const a of e.target.acceptable_anchors ?? []) {
      out.push({ what: "acceptable anchor", ref: a, via });
    }
  }
  if (e.kind === "sequence") {
    out.push({ what: "gold anchor", ref: e.target });
    if (e.sequence.must_anchor) {
      out.push({ what: "sequence anchor", ref: e.sequence.must_anchor });
      for (const a of e.sequence.must_anchor.acceptable_anchors ?? []) {
        out.push({ what: "sequence acceptable anchor", ref: a });
      }
    }
  }
  return out.map((o) => ({ ...o, via: o.via ?? "comment_on_quote" }));
}

/** Problems found, one line each; empty when the bank is sound. */
export function validateScenarios(scenarios: Scenario[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  {
    for (const s of scenarios) {
      if (ids.has(s.id)) problems.push(`${s.id}: duplicate scenario id`);
      ids.add(s.id);
      const refs = anchorsOf(s);
      if (refs.length === 0) continue;
      for (const { what, ref, via } of refs) {
        // A fresh document per check: each successful dispatch writes a comment.
        const doc = new Y.Doc();
        loadMarkdown(doc, fixtureFor(s).markdown);
        const outcome = dispatch(
          via,
          {
            quoted_text: ref.quoted_text,
            occurrence_index: ref.occurrence_index ?? 1,
            comment: "validation",
            suggested_text: "validation",
          },
          { ydoc: doc, canEdit: () => true },
        );
        doc.destroy();
        const eff = outcome.effect;
        const wanted = via === "propose_replacement" ? "replacement" : "comment";
        if (eff.kind !== wanted || !eff.ok) {
          const code =
            eff.kind === "comment" || eff.kind === "replacement" ? (eff.errorCode ?? "unknown") : eff.kind;
          problems.push(
            `${s.id}: ${what} does not resolve through the product's dispatch (${code}): ${JSON.stringify(ref.quoted_text.slice(0, 60))}`,
          );
        }
      }
    }
  }
  return problems;
}
