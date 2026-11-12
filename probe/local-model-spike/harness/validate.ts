/**
 * Start-up validation of the scenario bank (brief R2 "Judged by").
 *
 * Every gold anchor, acceptable anchor, selection and quote target is put
 * through the PRODUCT'S OWN dispatch (`comment_on_quote` on a scratch document
 * with editing allowed) — the route a model's quote takes — not through a
 * separate resolver. A run refuses to start when any of them fails.
 */
import * as Y from "yjs";

import { loadMarkdown } from "../../../src/server/file-io/markdown.js";
import { dispatch } from "../../../src/server/local-model/index.js";
import { fixtureFor } from "./scenarios/index.js";
import type { AnchorRef, Scenario } from "./scenarios/types.js";

function anchorsOf(s: Scenario): { what: string; ref: AnchorRef }[] {
  const out: { what: string; ref: AnchorRef }[] = [];
  const e = s.expect;
  if (s.selectedText !== undefined) out.push({ what: "selection", ref: { quoted_text: s.selectedText } });
  if (e.kind === "offer-change" || e.kind === "offer-comment") {
    out.push({ what: "target", ref: { quoted_text: e.target } });
  }
  if (e.kind === "annotation") {
    out.push({ what: "gold anchor", ref: e.target });
    for (const a of e.target.acceptable_anchors ?? []) out.push({ what: "acceptable anchor", ref: a });
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
  return out;
}

/** Problems found, one line each; empty when the bank is sound. */
export function validateScenarios(scenarios: Scenario[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const docs = new Map<string, Y.Doc>();
  try {
    for (const s of scenarios) {
      if (ids.has(s.id)) problems.push(`${s.id}: duplicate scenario id`);
      ids.add(s.id);
      const refs = anchorsOf(s);
      if (refs.length === 0) continue;
      for (const { what, ref } of refs) {
        // A fresh document per check: each successful dispatch writes a comment.
        const doc = new Y.Doc();
        loadMarkdown(doc, fixtureFor(s).markdown);
        const outcome = dispatch(
          "comment_on_quote",
          { quoted_text: ref.quoted_text, occurrence_index: ref.occurrence_index ?? 1, comment: "validation" },
          { ydoc: doc, canEdit: () => true },
        );
        doc.destroy();
        const eff = outcome.effect;
        if (eff.kind !== "comment" || !eff.ok) {
          const code = eff.kind === "comment" ? (eff.errorCode ?? "unknown") : eff.kind;
          problems.push(
            `${s.id}: ${what} does not resolve through the product's dispatch (${code}): ${JSON.stringify(ref.quoted_text.slice(0, 60))}`,
          );
        }
      }
    }
  } finally {
    for (const d of docs.values()) d.destroy();
  }
  return problems;
}
