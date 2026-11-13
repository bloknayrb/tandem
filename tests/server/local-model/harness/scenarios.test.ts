/**
 * The scenario bank and its fixtures (#1123 brief R2): group sizes, the
 * claimed shape of each new fixture against the product's inline threshold,
 * selections the editor can really send, and gold anchors checked through the
 * product's own dispatch.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fixtureText } from "../../../../probe/local-model-spike/harness/fixture-texts.js";
import { MIN_SCENARIOS_PER_GROUP } from "../../../../probe/local-model-spike/harness/report-core.js";
import { planTrials, scenarioSetHash } from "../../../../probe/local-model-spike/harness/runner.js";
import { inlineLimit } from "../../../../probe/local-model-spike/harness/scenarios/fixture-shape.js";
import {
  ALL_SCENARIOS,
  fixtureFor,
  fixtures,
  selectScenarios,
} from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import { JUNE_SCENARIOS } from "../../../../probe/local-model-spike/harness/scenarios/june.js";
import { GATING_GROUPS } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import { CLIENT_SELECTION_MAX } from "../../../../probe/local-model-spike/harness/trial.js";
import { validateScenarios } from "../../../../probe/local-model-spike/harness/validate.js";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.js";
import { getOutline, getSection } from "../../../../src/server/mcp/document.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LIMIT = inlineLimit();

function sections(markdown: string): { heading: string; text: string }[] {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, markdown);
    const fragment = doc.getXmlFragment("default");
    // The `##` sections: the title's own section is the whole document.
    return getOutline(fragment)
      .filter((h) => h.level >= 2)
      .map((h) => {
        const s = getSection(fragment, h.text);
        return { heading: h.text, text: s.found ? s.text : "" };
      });
  } finally {
    doc.destroy();
  }
}

describe("the chat tier's gating groups", () => {
  const chat = selectScenarios({ tier: "chat", mode: "full" });

  it("are the three named groups, each with at least 20 different scenarios", () => {
    expect([...GATING_GROUPS]).toEqual(["answerable", "unanswerable", "editing-request"]);
    const count = (g: string) => chat.filter((s) => s.group === g).length;
    expect({
      answerable: count("answerable"),
      unanswerable: count("unanswerable"),
      "editing-request": count("editing-request"),
      "no-action": count("no-action"),
    }).toEqual({ answerable: 24, unanswerable: 22, "editing-request": 22, "no-action": 6 });
    for (const g of GATING_GROUPS) expect(count(g)).toBeGreaterThanOrEqual(MIN_SCENARIOS_PER_GROUP);
    expect(chat).toHaveLength(74);
    // "Different": no two scenarios of a group share a message on the same document.
    const keys = chat.map((s) => `${s.fixture}\u0000${s.prompt}\u0000${s.selectedText ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("group 1: a quarter or more on documents the product does not inline, some just under the threshold, some with a selection", () => {
    const g1 = chat.filter((s) => s.group === "answerable");
    const size = (s: (typeof g1)[number]) => fixtureFor(s).shape?.size;
    expect(g1.filter((s) => size(s) === "deep").length).toBeGreaterThanOrEqual(
      Math.ceil(g1.length / 4),
    );
    expect(g1.filter((s) => size(s) === "just-under").length).toBeGreaterThanOrEqual(2);
    expect(g1.filter((s) => s.selectedText !== undefined).length).toBeGreaterThanOrEqual(4);
    for (const s of g1) {
      if (s.expect.kind !== "answer") throw new Error(`${s.id}: wrong expectation`);
      expect(s.expect.must.length, s.id).toBeGreaterThan(0);
      expect(fixtureFor(s).origin, `${s.id}: group 1 uses new fixtures only`).toBe("built");
    }
    expect(
      g1.filter((s) => s.expect.kind === "answer" && s.expect.mustNot.length === 0).length,
    ).toBeLessThanOrEqual(3);
  });

  it("groups 2 and 3 use new fixtures; group 3 is mostly selections on inlined documents", () => {
    const g2 = chat.filter((s) => s.group === "unanswerable");
    const g3 = chat.filter((s) => s.group === "editing-request");
    for (const s of [...g2, ...g3]) expect(fixtureFor(s).origin, s.id).toBe("built");
    expect(g3.filter((s) => s.selectedText !== undefined).length).toBeGreaterThan(g3.length / 2);
    for (const s of g3) {
      expect(fixtureFor(s).shape?.size, s.id).not.toBe("deep");
      if (s.expect.kind !== "offer-change" && s.expect.kind !== "offer-comment")
        throw new Error(s.id);
      if (s.selectedText !== undefined) expect(s.expect.target, s.id).toBe(s.selectedText);
    }
  });

  it("no scenario id appears twice, in one tier or across both", () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no task carries an annotation id or names a tool", () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.prompt, s.id).not.toMatch(/\b(?:ann|rpl)_\d/);
      if (s.tier === "chat") {
        expect(s.prompt, s.id).not.toMatch(
          /get_outline|read_section|comment_on_quote|propose_replacement|reply_to_annotation/,
        );
      }
    }
  });
});

describe("the editing tier and the extended bank", () => {
  it("holds June's scenarios unchanged, regrouped, plus the two thread paths", () => {
    const editing = selectScenarios({ tier: "editing", mode: "full" });
    const count = (g: string) => editing.filter((s) => s.group === g).length;
    expect({
      comment: count("comment"),
      replacement: count("replacement"),
      question: count("question"),
      "edit-no-action": count("edit-no-action"),
      thread: count("thread"),
    }).toEqual({ comment: 12, replacement: 12, question: 12, "edit-no-action": 3, thread: 2 });
    expect(editing).toHaveLength(41);

    const extended = selectScenarios({
      tier: "editing",
      mode: "full",
      includeExtended: true,
    }).filter((s) => s.extended);
    expect(extended).toHaveLength(12);
    expect(extended.filter((s) => s.group === "sequence")).toHaveLength(6);
    expect(extended.filter((s) => s.group === "envelope")).toHaveLength(6);

    // Every June scenario is still in the bank, with its prompt as measured.
    expect(JUNE_SCENARIOS).toHaveLength(51);
    for (const j of JUNE_SCENARIOS) {
      const now = ALL_SCENARIOS.find((s) => s.id === j.id);
      expect(now?.prompt, j.id).toBe(j.prompt);
      expect(now?.tier, j.id).toBe("editing");
    }
  });

  it("a default run never includes the extended bank, and a screen is chat-tier only", () => {
    expect(selectScenarios({ tier: "editing", mode: "full" }).some((s) => s.extended)).toBe(false);
    expect(selectScenarios({ tier: "chat", mode: "full" }).some((s) => s.extended)).toBe(false);
    expect(() => selectScenarios({ tier: "editing", mode: "screen" })).toThrow();
    expect(() => selectScenarios({ tier: "chat", mode: "full", includeExtended: true })).toThrow();
  });
});

describe("the screening subset", () => {
  it("is fixed, drawn from the gating groups, most discriminating first", () => {
    const screen = selectScenarios({ tier: "chat", mode: "screen" });
    expect(screen.map((s) => s.screenOrder)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(screen.slice(0, 8).every((s) => s.group === "editing-request")).toBe(true);
    expect(screen.slice(8, 14).every((s) => s.group === "unanswerable")).toBe(true);
    expect(
      screen
        .slice(14)
        .every((s) => s.group === "answerable" && fixtureFor(s).shape?.size === "deep"),
    ).toBe(true);
  });
});

describe("each new fixture has the shape it claims, against the product's threshold", () => {
  const built = [...fixtures().values()].filter((f) => f.origin === "built");

  it("there are fixtures of each size", () => {
    const sizes = built.map((f) => f.shape?.size);
    expect(sizes.filter((s) => s === "deep").length).toBeGreaterThanOrEqual(2);
    expect(sizes.filter((s) => s === "just-under").length).toBeGreaterThanOrEqual(1);
    expect(sizes.filter((s) => s === "inlined").length).toBeGreaterThanOrEqual(3);
  });

  for (const f of built) {
    it(`${f.key}: ${f.shape?.size}`, () => {
      const text = fixtureText(f.markdown);
      const shape = f.shape;
      if (!shape) throw new Error("a built fixture must state its shape");
      if (shape.size === "deep") {
        expect(text.length).toBeGreaterThan(LIMIT);
      } else if (shape.size === "just-under") {
        expect(text.length).toBeLessThanOrEqual(LIMIT);
        expect(text.length).toBeGreaterThanOrEqual(LIMIT * 0.9);
      } else {
        expect(text.length).toBeLessThan(LIMIT * 0.9);
      }
      for (const d of shape.distractors ?? []) expect(text, `distractor ${d}`).toContain(d);
      for (const a of shape.absent ?? [])
        expect(text.toLowerCase(), `absent ${a}`).not.toContain(a.toLowerCase());
      expect((shape.facts ?? []).length).toBeGreaterThan(0);
      for (const fact of shape.facts ?? []) expect(text, `fact ${fact.text}`).toContain(fact.text);

      if (shape.size === "deep") {
        const secs = sections(f.markdown);
        const headings = secs.map((s) => s.heading);
        expect(new Set(headings).size, "headings are unique").toBe(headings.length);
        // Short sections: one outline call and one section read reach an answer.
        const largest = Math.max(...secs.map((s) => s.text.length));
        expect(largest).toBeLessThanOrEqual(900);
        for (const fact of shape.facts ?? []) {
          expect(fact.heading, `deep fact "${fact.text}" names its section`).toBeDefined();
          const sec = secs.find((s) => s.heading === fact.heading);
          expect(sec?.text, `fact in section ${fact.heading}`).toContain(fact.text);
          // Deep inside: past the point where an inlined document would end.
          expect(text.indexOf(fact.text)).toBeGreaterThan(text.length * 0.6);
        }
      }
    });
  }

  it("states the largest section of the deep fixtures", () => {
    const largest = built
      .filter((f) => f.shape?.size === "deep")
      .map((f) => Math.max(...sections(f.markdown).map((s) => s.text.length)));
    expect(Math.max(...largest)).toBeLessThanOrEqual(900);
  });
});

describe("selections are ones the product's editor can send", () => {
  it("the harness limit is the client's cut-off, read from the client's source", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/client/editor/extensions/awareness.ts"),
      "utf8",
    );
    const m = /selectedText\.length > (\d+) \? selectedText\.slice\(0, (\d+)\) \+ "\.\.\."/.exec(
      source,
    );
    expect(m, "the client's selection cut-off has moved; re-read it").not.toBeNull();
    expect(Number(m?.[1])).toBe(CLIENT_SELECTION_MAX);
  });

  it("every selection is short, inside one paragraph, free of escapes, and occurs once", () => {
    const withSelection = ALL_SCENARIOS.filter((s) => s.selectedText !== undefined);
    expect(withSelection.length).toBeGreaterThanOrEqual(20);
    for (const s of withSelection) {
      const sel = s.selectedText as string;
      expect(sel.length, s.id).toBeLessThanOrEqual(190);
      expect(sel, s.id).not.toMatch(/[\n\\]/);
      const text = fixtureText(fixtureFor(s).markdown);
      expect(text.split(sel).length - 1, `${s.id}: selection occurs once`).toBe(1);
      // One paragraph: the line holding it is not a heading.
      const line = text.split("\n").find((l) => l.includes(sel)) ?? "";
      expect(line, s.id).not.toMatch(/^#/);
    }
  });
});

describe("start-up validation", () => {
  it("every gold anchor, selection and target resolves through the product's own dispatch", () => {
    expect(validateScenarios(ALL_SCENARIOS)).toEqual([]);
  });

  it("names the scenario whose anchor does not resolve, and one whose quote touches a heading", () => {
    const base = ALL_SCENARIOS.find((s) => s.id === "comment-cost-material");
    if (!base || base.expect.kind !== "annotation") throw new Error("missing scenario");
    const broken = {
      ...base,
      id: "broken",
      expect: { ...base.expect, target: { quoted_text: "not in the document" } },
    };
    const heading = {
      ...base,
      id: "on-heading",
      expect: { ...base.expect, target: { quoted_text: "## Cost Summary" } },
    };
    const problems = validateScenarios([broken, heading]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^broken: gold anchor does not resolve .*ANCHOR_NOT_FOUND/);
    expect(problems[1]).toMatch(/^on-heading: gold anchor does not resolve/);
  });
});

describe("the planned trials and the scenario-set hash", () => {
  it("one trial per scenario per repeat, and a hash that changes with a prompt or a fixture", () => {
    const chat = selectScenarios({ tier: "chat", mode: "full" });
    expect(planTrials(chat, 1)).toHaveLength(74);
    const twice = planTrials(chat, 2);
    expect(twice).toHaveLength(148);
    expect(new Set(twice.map((p) => p.trialId)).size).toBe(148);
    const hash = scenarioSetHash(chat);
    expect(scenarioSetHash(chat)).toBe(hash);
    expect(scenarioSetHash(chat.slice(1))).not.toBe(hash);
    expect(
      scenarioSetHash([{ ...chat[0], prompt: `${chat[0].prompt} ` }, ...chat.slice(1)]),
    ).not.toBe(hash);
  });
});
