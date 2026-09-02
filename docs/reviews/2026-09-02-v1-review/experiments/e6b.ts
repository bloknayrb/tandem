import * as Y from "yjs";
import { snapshotContradicts } from "../../../../src/shared/snapshot.ts";
const s = "x".repeat(199) + "\u{1F600}";
const kept = s.slice(0, 200);            // lone high surrogate at the end
const ann: any = { id: "a1", textSnapshot: kept, textSnapshotTruncated: true };
const actual = s + " and more text";
console.log("pre-roundtrip  contradicts:", snapshotContradicts(ann, actual));
const src = new Y.Doc(); src.getMap("m").set("a", ann);
const dst = new Y.Doc(); Y.applyUpdate(dst, Y.encodeStateAsUpdate(src));
const back: any = dst.getMap("m").get("a");
console.log("post-roundtrip contradicts:", snapshotContradicts(back, actual), "| snapshot changed:", back.textSnapshot !== kept);
// JSON path (durable annotation store on disk) for comparison
const viaJson = JSON.parse(JSON.stringify(ann));
console.log("post-JSON      contradicts:", snapshotContradicts(viaJson, actual), "| snapshot changed:", viaJson.textSnapshot !== kept);
