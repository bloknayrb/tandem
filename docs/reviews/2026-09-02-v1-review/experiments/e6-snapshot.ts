import * as Y from "yjs";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { captureSnapshot } from "../../../../src/server/mcp/annotations.ts";
import { validateRange, anchoredRange } from "../../../../src/server/positions.ts";
import { isSnapshotTruncated, snapshotSearchPrefix } from "../../../../src/shared/snapshot.ts";
import { toFlatOffset } from "../../../../src/shared/types.ts";

const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };

function relocatePass(doc: Y.Doc, ann: any) {
  // Faithful replication of src/server/documents/watcher.ts:214-262 (relocation pass)
  const truncated = isSnapshotTruncated(ann);
  const probe = snapshotSearchPrefix(ann);
  if (probe.length === 0) return { action: "skip (empty probe)" };
  const span = ann.range.to - ann.range.from;
  const probeTo = truncated ? toFlatOffset(ann.range.from + probe.length) : ann.range.to;
  const vr: any = validateRange(doc, ann.range.from, probeTo, { textSnapshot: probe });
  if (vr.ok) return { action: "valid (no move)", vr };
  if (vr.code === "RANGE_MOVED") {
    const resolvedTo = truncated ? toFlatOffset(vr.resolvedFrom + span) : vr.resolvedTo;
    const rel: any = truncated ? anchoredRange(doc, vr.resolvedFrom, resolvedTo) : anchoredRange(doc, vr.resolvedFrom, resolvedTo, ann.textSnapshot);
    return { action: "RELOCATED", vr, relocated: rel.ok ? rel.range : rel };
  }
  return { action: `NOT FOUND (${vr.code})`, vr };
}

function scenario(label: string, md: string, from: number, to: number) {
  const d = load(md);
  const flat = extractText(d);
  const snap = captureSnapshot(d, from, to);
  const ann: any = { id: "a1", type: "comment", author: "claude", status: "pending",
    range: { from, to }, textSnapshot: snap.text, textSnapshotTruncated: snap.truncated, breaks: snap.breaks };
  const lastCp = snap.text.charCodeAt(snap.text.length - 1);
  console.log(`--- ${label}`);
  console.log("  doc len", flat.length, "| range", `[${from},${to})`, "| snapshot len", snap.text.length, "truncated", snap.truncated);
  console.log("  snapshot tail :", JSON.stringify(snap.text.slice(-6)), "lastCharCode", lastCp.toString(16), "loneSurrogate:", lastCp >= 0xd800 && lastCp <= 0xdbff);
  console.log("  wellFormed    :", (snap.text as any).isWellFormed ? (snap.text as any).isWellFormed() : "n/a");
  // relocation against UNCHANGED text
  console.log("  relocate(unchanged doc):", JSON.stringify(relocatePass(d, ann)));
  // now simulate the record surviving a Yjs encode/decode round-trip (durable sync / provider)
  const d2 = load(md);
  {
    const src = new Y.Doc();
    src.getMap("annotations").set("a1", ann);
    const upd = Y.encodeStateAsUpdate(src);
    const dst = new Y.Doc();
    Y.applyUpdate(dst, upd);
    const back: any = dst.getMap("annotations").get("a1");
    const same = back.textSnapshot === ann.textSnapshot;
    console.log("  after Yjs update round-trip: snapshot identical:", same, "| tail now", JSON.stringify(String(back.textSnapshot).slice(-6)));
    console.log("  relocate(after round-trip):", JSON.stringify(relocatePass(d2, back)));
  }
}

// (a) 200-char boundary lands in the middle of a surrogate pair
{
  const head = "x".repeat(199);           // chars 0..198
  const body = head + "\u{1F600}" + " tail words follow here and continue on for a while.";
  scenario("(a) emoji straddling the 200-char cap", body + "\n", 0, body.length);
}
// (b) 200-char boundary right after a hard break
{
  // put a hard break so that flat offset 199 is the "\n" it contributes
  const a = "y".repeat(199);
  const md = a + "\\\n" + "z".repeat(60) + "\n";   // backslash hard break
  const d = load(md); const flat = extractText(d);
  console.log("### (b) probe: flat[195..205] =", JSON.stringify(flat.slice(195, 205)), "len", flat.length);
  scenario("(b) hard break at the cap boundary", md, 0, flat.length);
}
// (c) control: short untruncated snapshot
scenario("(c) control, no truncation", "hello brave new world\n", 6, 11);
