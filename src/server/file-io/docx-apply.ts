// Apply accepted suggestions to a .docx as tracked changes (w:del + w:ins).
//
// Uses the shared walker (docx-walker.ts) to map flat-text offsets into
// the XML DOM, then mutates the DOM in-place before serializing back to ZIP.

import JSZip from "jszip";
import { parseDocument } from "htmlparser2";
import { Element, Text } from "domhandler";
import type { ChildNode } from "domhandler";
import render from "dom-serializer";
import {
  walkDocumentBody,
  findAllByName,
  isElement,
  getAttr,
  type TextHit,
} from "./docx-walker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OffsetEntry {
  run: Element;
  textNode: Element;
  /** Character index within the textNode's text content. */
  charIndex: number;
  paragraph: Element;
  paragraphId?: string;
}

export interface OffsetMap {
  get(offset: number): OffsetEntry | undefined;
  flatText: string;
  totalLength: number;
  /** The parsed <w:body> element — same DOM tree as all OffsetEntry references. */
  body: Element;
  /** The full parsed document (parent of body). */
  doc: ReturnType<typeof parseDocument>;
  /** Maps Word comment IDs to w14:paraId values. */
  commentParagraphIds: Map<string, string>;
}

export interface SuggestionInput {
  from: number;
  to: number;
  newText: string;
  author: string;
  date: string;
  revisionId: number;
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

export interface AcceptedSuggestion {
  id: string;
  from: number;
  to: number;
  newText: string;
  textSnapshot?: string;
  /** Word comment ID if this suggestion overlaps an imported comment. */
  importCommentId?: string;
}

export interface ApplyOptions {
  author: string;
  ydocFlatText: string;
  date?: string;
}

export interface ApplyOutput {
  buffer: Buffer;
  applied: number;
  rejected: number;
  rejectedDetails: Array<{ id: string; reason: string }>;
  commentsResolved: number;
}

// ---------------------------------------------------------------------------
// buildOffsetMap
// ---------------------------------------------------------------------------

/**
 * Walk the document body and build a lookup from flat-text offset to the
 * corresponding XML DOM position (run, text node, char index within node).
 */
export function buildOffsetMap(xml: string, targetOffsets: Set<number>): OffsetMap {
  const entries = new Map<number, OffsetEntry>();
  const commentParagraphIds = new Map<string, string>();

  // Collect text hits so we can resolve offsets after the walk
  const hits: TextHit[] = [];

  const { totalLength, flatText } = walkDocumentBody(xml, {
    onText(hit) {
      hits.push(hit);
    },
    onCommentStart(hit) {
      if (hit.paragraphId) {
        commentParagraphIds.set(hit.commentId, hit.paragraphId);
      }
    },
  });

  // For each target offset, find the text hit that contains it
  for (const offset of targetOffsets) {
    // Special case: end-of-document offset
    if (offset === totalLength && hits.length > 0) {
      const lastHit = hits[hits.length - 1];
      entries.set(offset, {
        run: lastHit.run,
        textNode: lastHit.textNode,
        charIndex: lastHit.text.length,
        paragraph: lastHit.paragraph,
        paragraphId: lastHit.paragraphId,
      });
      continue;
    }

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const start = hit.offsetStart;
      const end = start + hit.text.length;
      if (offset >= start && offset < end) {
        entries.set(offset, {
          run: hit.run,
          textNode: hit.textNode,
          charIndex: offset - start,
          paragraph: hit.paragraph,
          paragraphId: hit.paragraphId,
        });
        break;
      }
      // Allow offset === end for the last character boundary of a text node,
      // but only if no subsequent hit starts at that offset (prefer the start
      // of the next node).
      if (offset === end) {
        const nextHit = hits[i + 1];
        if (!nextHit || nextHit.offsetStart !== offset) {
          entries.set(offset, {
            run: hit.run,
            textNode: hit.textNode,
            charIndex: hit.text.length,
            paragraph: hit.paragraph,
            paragraphId: hit.paragraphId,
          });
          break;
        }
      }
    }
  }

  // Walk back from a paragraph node to find the body and document.
  // The walker parsed the XML internally, so all hit nodes share the same DOM.
  const doc = parseDocument(xml, { xmlMode: true });
  const bodyElements = findAllByName("w:body", doc.children);

  // We need the body from the SAME parse that the walker used. Since
  // walkDocumentBody parses internally and we can't access its Document,
  // we recover body/doc from the first hit's parent chain instead.
  let walkerBody: Element;
  let walkerDoc: ReturnType<typeof parseDocument>;
  if (hits.length > 0) {
    // Walk up from the first paragraph to find body and document
    let node = hits[0].paragraph.parent;
    while (node && isElement(node) && node.name !== "w:body") {
      node = node.parent;
    }
    walkerBody = node as Element;
    walkerDoc = walkerBody.parent as unknown as ReturnType<typeof parseDocument>;
  } else {
    // No hits — use our own parse (no entries reference it anyway)
    walkerBody = bodyElements[0] ?? new Element("w:body", {});
    walkerDoc = doc;
  }

  return {
    get(offset: number) {
      return entries.get(offset);
    },
    flatText,
    totalLength,
    body: walkerBody,
    doc: walkerDoc,
    commentParagraphIds,
  };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Get the text content of a w:t or w:delText element. */
function getNodeText(node: Element): string {
  for (const child of node.children) {
    if (child.type === "text") return (child as unknown as Text).data;
  }
  return "";
}

/** Set the text content of a w:t or w:delText element. */
function setNodeText(node: Element, text: string): void {
  const textChild = new Text(text);
  (textChild as ChildNode).parent = node;
  node.children = [textChild];
  // Preserve spaces if needed
  if (text.startsWith(" ") || text.endsWith(" ")) {
    node.attribs["xml:space"] = "preserve";
  } else {
    delete node.attribs["xml:space"];
  }
}

/** Clone a w:rPr element by serializing and re-parsing. */
function cloneRPr(rPr: Element): Element {
  const serialized = render(rPr, { xmlMode: true });
  const doc = parseDocument(serialized, { xmlMode: true });
  return doc.children[0] as Element;
}

/** Find the w:rPr child of a w:r run, if any. */
function findRPr(run: Element): Element | undefined {
  for (const child of run.children) {
    if (isElement(child) && child.name === "w:rPr") return child;
  }
  return undefined;
}

/** Build a new w:r element with optional rPr and a text element. */
function buildRun(
  textElementName: "w:t" | "w:delText",
  text: string,
  rPrSource?: Element,
): Element {
  const children: ChildNode[] = [];

  if (rPrSource) {
    const cloned = cloneRPr(rPrSource);
    children.push(cloned);
  }

  const textChild = new Text(text);
  const attribs: Record<string, string> = {};
  if (text.startsWith(" ") || text.endsWith(" ")) {
    attribs["xml:space"] = "preserve";
  }
  const textNode = new Element(textElementName, attribs, [textChild]);
  (textChild as ChildNode).parent = textNode;
  children.push(textNode);

  const run = new Element("w:r", {}, children);
  for (const child of children) {
    (child as ChildNode).parent = run;
  }
  return run;
}

/** Insert a node into a parent's children array at a given index. */
function insertChild(parent: Element, index: number, node: ChildNode): void {
  parent.children.splice(index, 0, node);
  node.parent = parent;
}

/** Remove a node from its parent's children array. */
function removeChild(node: ChildNode): void {
  if (!node.parent) return;
  const parent = node.parent as Element;
  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);
  node.parent = null;
}

// ---------------------------------------------------------------------------
// applySingleSuggestion
// ---------------------------------------------------------------------------

/**
 * Apply a single tracked-change suggestion to the document body.
 *
 * Wraps the original text in `<w:del>` (using `<w:delText>`) and inserts
 * `<w:ins>` with the replacement. Inherits `<w:rPr>` from the first deleted run.
 */
export function applySingleSuggestion(
  _body: Element,
  offsetMap: OffsetMap,
  suggestion: SuggestionInput,
): ApplyResult {
  const { from, to, newText, author, date, revisionId } = suggestion;

  const fromEntry = offsetMap.get(from);
  const toEntry = offsetMap.get(to);

  if (!fromEntry || !toEntry) {
    return { ok: false, reason: `Could not resolve offsets: from=${from} to=${to}` };
  }

  if (fromEntry.paragraph !== toEntry.paragraph) {
    return { ok: false, reason: "Cross-paragraph suggestions not yet supported" };
  }

  const paragraph = fromEntry.paragraph;

  // Collect all w:r runs between from and to within this paragraph.
  // We need to find runs that contain text in the [from, to) range.
  // Strategy: split boundary runs if needed, then wrap interior runs.

  // Step 1: Split the "from" run if charIndex > 0
  if (fromEntry.charIndex > 0) {
    splitRun(fromEntry.run, fromEntry.textNode, fromEntry.charIndex, paragraph);
    // After split, fromEntry.run is the "before" part; the text we want
    // starts in the newly created run (next sibling).
    const idx = paragraph.children.indexOf(fromEntry.run);
    const nextRun = paragraph.children[idx + 1];
    if (!nextRun || !isElement(nextRun) || nextRun.name !== "w:r") {
      return { ok: false, reason: "Split failed: no next run after from-split" };
    }
    // Update fromEntry to point to the new run
    fromEntry.run = nextRun;
    fromEntry.textNode = findTextNode(nextRun)!;
    fromEntry.charIndex = 0;
  }

  // Step 2: Split the "to" run if charIndex < text length
  const toText = getNodeText(toEntry.textNode);
  if (toEntry.charIndex < toText.length && toEntry.charIndex > 0) {
    splitRun(toEntry.run, toEntry.textNode, toEntry.charIndex, paragraph);
    // After split, toEntry.run has text [0..charIndex), and the rest is in a new run.
    // We want to include toEntry.run in the deletion (it has the first part).
    // toEntry now correctly points to the run ending at the split point.
  } else if (toEntry.charIndex === 0) {
    // The "to" offset is at the start of this run — don't include this run.
    // We delete everything up to but not including toEntry.run.
  }

  // Step 3: Collect all runs between fromEntry.run and toEntry.run (inclusive/exclusive)
  const runsToDelete: Element[] = [];
  let collecting = false;

  for (const child of paragraph.children) {
    if (!isElement(child) || child.name !== "w:r") {
      if (collecting && child === toEntry.run) break;
      continue;
    }

    if (child === fromEntry.run) {
      collecting = true;
    }

    if (collecting) {
      if (toEntry.charIndex === 0 && child === toEntry.run) {
        // Don't include this run — "to" is at its start
        break;
      }
      runsToDelete.push(child);
      if (child === toEntry.run) {
        break;
      }
    }
  }

  if (runsToDelete.length === 0) {
    // Edge case: from === to (insertion only, no deletion)
    if (from === to && newText.length > 0) {
      const insertionPoint = paragraph.children.indexOf(fromEntry.run);
      const rPr = findRPr(fromEntry.run);
      const insRun = buildRun("w:t", newText, rPr);
      const ins = new Element(
        "w:ins",
        {
          "w:id": String(revisionId + 1),
          "w:author": author,
          "w:date": date,
        },
        [insRun],
      );
      (insRun as ChildNode).parent = ins;
      insertChild(paragraph, insertionPoint, ins);
      return { ok: true };
    }
    return { ok: false, reason: "No runs found in deletion range" };
  }

  // Step 4: Build w:del element with w:delText runs
  const rPrSource = findRPr(runsToDelete[0]);
  const delChildren: ChildNode[] = [];

  for (const run of runsToDelete) {
    const text = getNodeText(findTextNode(run)!);
    const delRun = buildRun("w:delText", text, findRPr(run));
    delChildren.push(delRun);
  }

  const del = new Element(
    "w:del",
    {
      "w:id": String(revisionId),
      "w:author": author,
      "w:date": date,
    },
    delChildren,
  );
  for (const child of delChildren) {
    (child as ChildNode).parent = del;
  }

  // Step 5: Build w:ins element if newText is non-empty
  let ins: Element | undefined;
  if (newText.length > 0) {
    const insRun = buildRun("w:t", newText, rPrSource);
    ins = new Element(
      "w:ins",
      {
        "w:id": String(revisionId + 1),
        "w:author": author,
        "w:date": date,
      },
      [insRun],
    );
    (insRun as ChildNode).parent = ins;
  }

  // Step 6: Replace the original runs with del (+ ins)
  const firstRunIndex = paragraph.children.indexOf(runsToDelete[0]);

  // Remove original runs
  for (const run of runsToDelete) {
    removeChild(run);
  }

  // Insert del at the position of the first removed run
  insertChild(paragraph, firstRunIndex, del);

  // Insert ins after del
  if (ins) {
    insertChild(paragraph, firstRunIndex + 1, ins);
  }

  return { ok: true };
}

/** Split a run at charIndex, creating a new run after it with the remainder. */
function splitRun(run: Element, textNode: Element, charIndex: number, paragraph: Element): void {
  const fullText = getNodeText(textNode);
  const before = fullText.slice(0, charIndex);
  const after = fullText.slice(charIndex);

  // Update the original run's text
  setNodeText(textNode, before);

  // Create a new run for the remainder
  const rPr = findRPr(run);
  const newRun = buildRun("w:t", after, rPr);

  // Insert after the original run in the paragraph
  const idx = paragraph.children.indexOf(run);
  insertChild(paragraph, idx + 1, newRun);
}

/** Find the w:t element within a run. */
function findTextNode(run: Element): Element | undefined {
  for (const child of run.children) {
    if (isElement(child) && child.name === "w:t") return child;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// applyTrackedChanges (orchestrator)
// ---------------------------------------------------------------------------

/**
 * Apply accepted suggestions to a .docx buffer as tracked changes.
 *
 * Returns a new buffer with the modified document plus statistics.
 */
export async function applyTrackedChanges(
  docxBuffer: Buffer,
  suggestions: AcceptedSuggestion[],
  options: ApplyOptions,
): Promise<ApplyOutput> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) {
    throw new Error("Missing word/document.xml in .docx archive");
  }

  const date = options.date ?? new Date().toISOString();

  // Collect all target offsets
  const targetOffsets = new Set<number>();
  for (const s of suggestions) {
    targetOffsets.add(s.from);
    targetOffsets.add(s.to);
  }

  // Build offset map (first pass — for comparison guard only)
  const offsetMap = buildOffsetMap(documentXml, targetOffsets);

  // Comparison guard
  if (offsetMap.flatText !== options.ydocFlatText) {
    throw new Error(
      "Flat text mismatch: the .docx content does not match the Y.Doc flat text. " +
        "The file may have changed since it was loaded.",
    );
  }

  // Sort descending by `from` so later edits don't shift earlier offsets
  const sorted = [...suggestions].sort((a, b) => b.from - a.from);

  // Validate ALL before mutating
  const valid: AcceptedSuggestion[] = [];
  const rejectedDetails: Array<{ id: string; reason: string }> = [];

  for (const s of sorted) {
    // textSnapshot check
    if (s.textSnapshot !== undefined) {
      const actual = offsetMap.flatText.slice(s.from, s.to);
      if (actual !== s.textSnapshot) {
        rejectedDetails.push({
          id: s.id,
          reason: `Text snapshot mismatch: expected "${s.textSnapshot}", got "${actual}"`,
        });
        continue;
      }
    }

    // Offset resolution check
    const fromEntry = offsetMap.get(s.from);
    const toEntry = offsetMap.get(s.to);
    if (!fromEntry || !toEntry) {
      rejectedDetails.push({
        id: s.id,
        reason: `Could not resolve offsets: from=${s.from} to=${s.to}`,
      });
      continue;
    }

    valid.push(s);
  }

  // Check for overlapping ranges among valid suggestions (already sorted desc by from)
  const validAfterOverlapCheck: AcceptedSuggestion[] = [];
  let lastFrom = Infinity;
  for (const s of valid) {
    if (s.to > lastFrom) {
      rejectedDetails.push({
        id: s.id,
        reason: `Overlapping range [${s.from}, ${s.to}) conflicts with another suggestion`,
      });
      continue;
    }
    lastFrom = s.from;
    validAfterOverlapCheck.push(s);
  }

  // The offset map already parsed the XML — reuse its DOM for mutation
  const body = offsetMap.body;
  const doc = offsetMap.doc;

  // Find max existing w:id to avoid collisions
  const idMatches = documentXml.match(/w:id="(\d+)"/g) || [];
  let maxId = 0;
  for (const m of idMatches) {
    const num = parseInt(m.match(/\d+/)![0], 10);
    if (num > maxId) maxId = num;
  }

  // Apply each valid suggestion in reverse offset order
  let applied = 0;
  for (const s of validAfterOverlapCheck) {
    maxId += 2; // reserve two IDs: one for del, one for ins
    const result = applySingleSuggestion(body, offsetMap, {
      from: s.from,
      to: s.to,
      newText: s.newText,
      author: options.author,
      date,
      revisionId: maxId - 1,
    });
    if (result.ok) {
      applied++;
    } else {
      rejectedDetails.push({ id: s.id, reason: result.reason ?? "Unknown error" });
    }
  }

  // Serialize back
  const serialized = render(doc, { xmlMode: true });
  zip.file("word/document.xml", serialized);

  // Resolve Word comments
  const commentsResolved = await resolveWordComments(
    zip,
    offsetMap.commentParagraphIds,
    validAfterOverlapCheck.filter((_, i) => {
      // Only include successfully applied suggestions
      // Since we applied in order from validAfterOverlapCheck, check the rejectedDetails
      return !rejectedDetails.some((r) => r.id === validAfterOverlapCheck[i]?.id);
    }),
  );

  const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

  return {
    buffer,
    applied,
    rejected: rejectedDetails.length,
    rejectedDetails,
    commentsResolved,
  };
}

// ---------------------------------------------------------------------------
// resolveWordComments
// ---------------------------------------------------------------------------

const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

/**
 * Mark Word comments as "done" in commentsExtended.xml.
 *
 * For each applied suggestion that has an `importCommentId`, looks up the
 * comment's paragraph ID and writes a `<w15:commentEx w15:paraId="..." w15:done="1"/>`
 * entry.
 */
export async function resolveWordComments(
  zip: JSZip,
  commentParagraphIds: Map<string, string>,
  appliedSuggestions: AcceptedSuggestion[],
): Promise<number> {
  // Collect comment IDs to resolve
  const toResolve: Array<{ commentId: string; paraId: string }> = [];
  for (const s of appliedSuggestions) {
    if (!s.importCommentId) continue;
    const paraId = commentParagraphIds.get(s.importCommentId);
    if (!paraId) {
      console.warn(`[docx-apply] No paraId for comment ${s.importCommentId}; skipping resolution`);
      continue;
    }
    toResolve.push({ commentId: s.importCommentId, paraId });
  }

  if (toResolve.length === 0) return 0;

  // Deduplicate by commentId
  const seen = new Set<string>();
  const unique = toResolve.filter((r) => {
    if (seen.has(r.commentId)) return false;
    seen.add(r.commentId);
    return true;
  });

  const existingXml = await zip.file("word/commentsExtended.xml")?.async("text");

  if (existingXml) {
    // Parse and append
    const doc = parseDocument(existingXml, { xmlMode: true });
    const root = doc.children.find((c) => isElement(c) && c.name === "w15:commentsEx") as
      | Element
      | undefined;
    if (root) {
      for (const { paraId } of unique) {
        const entry = new Element("w15:commentEx", {
          "w15:paraId": paraId,
          "w15:done": "1",
        });
        insertChild(root, root.children.length, entry);
      }
      zip.file("word/commentsExtended.xml", render(doc, { xmlMode: true }));
    }
  } else {
    // Create new commentsExtended.xml
    const entries = unique
      .map((r) => `<w15:commentEx w15:paraId="${r.paraId}" w15:done="1"/>`)
      .join("");
    const newXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w15:commentsEx xmlns:w15="${W15_NS}">${entries}</w15:commentsEx>`;
    zip.file("word/commentsExtended.xml", newXml);

    // Add relationship in word/_rels/document.xml.rels
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("text");
    if (relsXml) {
      const relsDoc = parseDocument(relsXml, { xmlMode: true });
      const relsRoot = relsDoc.children.find((c) => isElement(c) && c.name === "Relationships") as
        | Element
        | undefined;
      if (relsRoot) {
        // Find a unique rId
        const existingIds = findAllByName("Relationship", relsRoot.children)
          .map((r) => getAttr(r, "Id") || "")
          .filter((id) => id.startsWith("rId"))
          .map((id) => parseInt(id.slice(3), 10))
          .filter((n) => !isNaN(n));
        const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 100;

        const rel = new Element("Relationship", {
          Id: `rId${nextId}`,
          Type: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
          Target: "commentsExtended.xml",
        });
        insertChild(relsRoot, relsRoot.children.length, rel);
        zip.file("word/_rels/document.xml.rels", render(relsDoc, { xmlMode: true }));
      }
    }

    // Add content type
    const ctXml = await zip.file("[Content_Types].xml")?.async("text");
    if (ctXml) {
      const ctDoc = parseDocument(ctXml, { xmlMode: true });
      const typesRoot = ctDoc.children.find((c) => isElement(c) && c.name === "Types") as
        | Element
        | undefined;
      if (typesRoot) {
        const override = new Element("Override", {
          PartName: "/word/commentsExtended.xml",
          ContentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
        });
        insertChild(typesRoot, typesRoot.children.length, override);
        zip.file("[Content_Types].xml", render(ctDoc, { xmlMode: true }));
      }
    }
  }

  return unique.length;
}
