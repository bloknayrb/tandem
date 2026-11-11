import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import {
  buildUserPrompt,
  CHAT_SYSTEM_PROMPT,
  EDITING_SYSTEM_PROMPT,
  systemPromptFor,
} from "../../../src/server/local-model/prompts.js";
import { READ_TOOL_NAMES, READ_TOOLS, TOOLS } from "../../../src/server/local-model/tools.js";
import { makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

let doc: Y.Doc | undefined;
afterEach(() => {
  doc?.destroy();
  doc = undefined;
});

// The prompts are two tiers (#1123, ADR-039 as built 2026-11-11), and they are
// pinned here. This replaces the earlier note that the system prompt was a
// frozen verbatim port of the M0 spike and "not tested by design": the brief
// for #1123 amends that on purpose. What holds now:
//
//  - EDITING_SYSTEM_PROMPT is the spike's text with ONE section inserted. Every
//    original section is still there verbatim (checked against the spike file
//    itself, which stays as it was), but the prompt as a whole is no longer
//    identical to `probe/local-model-spike/prompts.ts`.
//  - CHAT_SYSTEM_PROMPT is new, and names no writing tool.
//
// So the spike's measured pass rates describe neither shipped prompt. These
// tests pin wording, not model behaviour — nothing here runs a model.

/** Writing tools, derived from the registry: a writing tool added later is
 *  looked for in every chat-tier string below without anyone listing it. */
const WRITING_TOOL_NAMES = TOOLS.filter((t) => !READ_TOOLS.includes(t)).map((t) => t.name);

function namedWritingTools(text: string): string[] {
  return WRITING_TOOL_NAMES.filter((n) => text.includes(n));
}

/** The spike's SYSTEM_PROMPT, read as text (the probe directory is not
 *  typechecked, so it is not imported). Line endings are normalized because a
 *  Windows checkout may hold the file as CRLF. */
function spikeSystemPrompt(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", "..", "..", "probe", "local-model-spike", "prompts.ts");
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = /export const SYSTEM_PROMPT = `([\s\S]*?)`;/.exec(source);
  if (!match?.[1]) throw new Error("could not find SYSTEM_PROMPT in the spike's prompts.ts");
  return match[1];
}

describe("the derived writing-tool set", () => {
  it("is not empty — the 'names no writing tool' checks below are checking something", () => {
    expect(WRITING_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const n of WRITING_TOOL_NAMES) expect(READ_TOOL_NAMES.has(n), n).toBe(false);
  });
});

describe("systemPromptFor", () => {
  it("maps each tier to its prompt, and the two differ", () => {
    expect(systemPromptFor("editing")).toBe(EDITING_SYSTEM_PROMPT);
    expect(systemPromptFor("chat")).toBe(CHAT_SYSTEM_PROMPT);
    expect(CHAT_SYSTEM_PROMPT).not.toBe(EDITING_SYSTEM_PROMPT);
  });
});

describe("EDITING_SYSTEM_PROMPT", () => {
  it("keeps every section of the spike's prompt verbatim, with one section inserted", () => {
    const spike = spikeSystemPrompt();
    const cut = spike.indexOf("\n\nDISCIPLINE\n");
    expect(cut).toBeGreaterThan(0);
    const head = spike.slice(0, cut); // intro + HOW TO ACT + ANCHORING
    const tail = spike.slice(cut); // DISCIPLINE
    expect(head).toContain("HOW TO ACT");
    expect(head).toContain("ANCHORING — THIS IS CRITICAL");

    expect(EDITING_SYSTEM_PROMPT.startsWith(head)).toBe(true);
    expect(EDITING_SYSTEM_PROMPT.endsWith(tail)).toBe(true);

    // ...and it is no longer the spike's prompt: exactly one section sits
    // between the two halves.
    expect(EDITING_SYSTEM_PROMPT).not.toBe(spike);
    const inserted = EDITING_SYSTEM_PROMPT.slice(
      head.length,
      EDITING_SYSTEM_PROMPT.length - tail.length,
    );
    expect(inserted.startsWith("\n\nYOU PROPOSE, THE USER DECIDES\n")).toBe(true);
    // One section: a single heading line, then bullets only.
    const lines = inserted.trim().split("\n");
    expect(lines.slice(1).every((l) => l.startsWith("- "))).toBe(true);
  });

  it("names every writing tool (the reading tools are described by their schemas, as in the spike)", () => {
    for (const n of WRITING_TOOL_NAMES) expect(EDITING_SYSTEM_PROMPT, n).toContain(n);
  });

  it("says its tools only propose and the user accepts or rejects (R3.1)", () => {
    expect(EDITING_SYSTEM_PROMPT).toContain("Your tools never change the document text.");
    expect(EDITING_SYSTEM_PROMPT).toMatch(/A replacement is a SUGGESTION/);
    expect(EDITING_SYSTEM_PROMPT).toMatch(/changes nothing until the user accepts it/);
    expect(EDITING_SYSTEM_PROMPT).toMatch(/the user may reject it/);
  });

  it("says never to tell the user a change was made (R3.1)", () => {
    expect(EDITING_SYSTEM_PROMPT).toMatch(
      /never tell the user that a change was made, applied, or is now in the document/,
    );
    expect(EDITING_SYSTEM_PROMPT).toMatch(/waiting for them to accept or reject/);
  });

  it("tells the model what an EDITING_OFF refusal means", () => {
    expect(EDITING_SYSTEM_PROMPT).toMatch(/EDITING_OFF/);
    expect(EDITING_SYSTEM_PROMPT).toMatch(/answer in plain text/);
  });
});

describe("CHAT_SYSTEM_PROMPT", () => {
  it("names no writing tool (R2.6)", () => {
    expect(namedWritingTools(CHAT_SYSTEM_PROMPT)).toEqual([]);
  });

  it("names the reading tools, and says they are the only ones", () => {
    for (const n of READ_TOOL_NAMES) expect(CHAT_SYSTEM_PROMPT, n).toContain(n);
    expect(CHAT_SYSTEM_PROMPT).toContain("These are the only tools you have.");
  });

  it("says it cannot change the document", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(
      "You cannot change the document, add comments to it, or mark it up in any way.",
    );
    expect(CHAT_SYSTEM_PROMPT).toMatch(
      /Never tell the user that you changed, edited, fixed or commented on the document/,
    );
  });

  it("carries none of the editing tier's anchoring instructions", () => {
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(/anchor/i);
    expect(CHAT_SYSTEM_PROMPT).not.toContain("quoted_text");
    expect(CHAT_SYSTEM_PROMPT).not.toContain("occurrence_index");
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(/annotation id\b/);
  });
});

describe("both system prompts", () => {
  for (const [tier, prompt] of [
    ["editing", EDITING_SYSTEM_PROMPT],
    ["chat", CHAT_SYSTEM_PROMPT],
  ] as const) {
    it(`${tier}: tells the model not to quote internal ids to the user (R3.2)`, () => {
      expect(prompt).toContain(
        "- Never quote annotation ids, reply ids or any other internal id to the user.",
      );
      expect(prompt).toMatch(/refer to the text instead/);
    });
  }
});

// buildUserPrompt carries the ADR-039 §4 context-window branch, per tier.
describe("buildUserPrompt — editing tier keeps the original wording", () => {
  it("inlines the full document text when includeText is true", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, "Improve this.", true, "editing");
    expect(p).toContain("<document>");
    expect(p).toContain("Hello world.");
    expect(p).toContain("Task: Improve this.");
    expect(
      p.startsWith("Here is the full document text (quote from this verbatim when anchoring):"),
    ).toBe(true);
  });

  it("omits the document and points at the read tools when includeText is false", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, "Improve this.", false, "editing");
    expect(p).not.toContain("<document>");
    expect(p).not.toContain("Hello world.");
    expect(p).toBe(
      "Improve this.\n\nThe document is long. Use get_outline and read_section to read the relevant parts before anchoring.",
    );
  });
});

describe("buildUserPrompt — chat tier (R2.6)", () => {
  // The task is fixed and names no tool, so anything found is the template's.
  const TASK = "What is this about?";

  it("inlines the full document text when includeText is true", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, TASK, true, "chat");
    expect(p).toContain("<document>");
    expect(p).toContain("Hello world.");
    expect(p).toContain(`Task: ${TASK}`);
    expect(p.startsWith("Here is the full document text:\n")).toBe(true);
  });

  it("omits the document and points at the read tools when includeText is false", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, TASK, false, "chat");
    expect(p).not.toContain("<document>");
    expect(p).not.toContain("Hello world.");
    expect(p).toContain("get_outline");
    expect(p).toContain("read_section");
    expect(p).toMatch(/before answering\.$/);
  });

  for (const includeText of [true, false]) {
    it(`names no writing tool and has no anchoring wording (includeText: ${includeText})`, () => {
      doc = makeMarkdownDoc("# Title\n\nHello world.\n");
      const p = buildUserPrompt(doc, TASK, includeText, "chat");
      expect(namedWritingTools(p)).toEqual([]);
      expect(p).not.toMatch(/anchor/i);
      expect(p).not.toMatch(/quote from this verbatim/i);
    });
  }

  it("differs from the editing tier in both arms", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    for (const includeText of [true, false]) {
      expect(buildUserPrompt(doc, TASK, includeText, "chat")).not.toBe(
        buildUserPrompt(doc, TASK, includeText, "editing"),
      );
    }
  });
});
