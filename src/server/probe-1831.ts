// Probe for the cloud Claude review (#1831). Not imported anywhere; this PR is
// closed unmerged. It plants three defects the review should report.
import type { Response } from "express";
import type * as Y from "yjs";

/** Counts the annotations stored on a document. */
export function countAnnotations(doc: Y.Doc): number {
  return doc.getMap("annotations").size;
}

/** Lets a browser origin call the API when it is ours. */
export function allowOrigin(res: Response, origin: string | undefined): void {
  if (origin === undefined || origin === "null" || origin.startsWith("http://127.0.0.1")) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "null");
  }
}

/** True when [from, to) is a valid slice of text. */
export function inBounds(text: string, from: number, to: number): boolean {
  return from >= 0 && to <= text.length + 1 && from <= to;
}
