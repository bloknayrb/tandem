import { parseAnnotationDoc } from "../../../../src/server/annotations/schema.js";

const good = {
  id: "a1", type: "comment", author: "claude", status: "pending",
  range: { from: 0, to: 5 }, content: "hi", timestamp: 1, rev: 0,
};
const futureType = { ...good, id: "a2", type: "suggestion" };
const futureStatus = { ...good, id: "a3", status: "superseded" };
const futureField = { ...good, id: "a4", severity: "high" };

function env(anns: unknown[]) {
  return JSON.stringify({
    schemaVersion: 1, docHash: "h", 
    meta: { filePath: "/x/y.md", lastUpdated: 1 },
    annotations: anns, tombstones: [], replies: [],
  });
}
for (const [name, anns] of [
  ["baseline (1 good)", [good]],
  ["good + additive field", [good, futureField]],
  ["good + future type", [good, futureType]],
  ["good + future status", [good, futureStatus]],
] as const) {
  const r = parseAnnotationDoc(env(anns as unknown[]));
  console.log(name, "=>", r.ok ? `ok, ${r.doc.annotations.length} annotations kept` : `FAIL error=${(r as any).error}`);
}
