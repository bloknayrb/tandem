import fs from "fs/promises";
import path from "path";
import { createStore, getAnnotationsDir } from "../../../../src/server/annotations/store.js";

const HASH = "a".repeat(64);

function v2Envelope(marker: string) {
  return JSON.stringify({
    schemaVersion: 2,
    docHash: HASH,
    meta: { filePath: "/x/y.md", lastUpdated: 1 },
    annotations: [{ id: marker, author: "user", type: "note", range: { from: 0, to: 3 },
      content: marker, status: "pending", timestamp: 1, rev: 0 }],
    tombstones: [],
    replies: [],
  });
}

async function main() {
  const dir = getAnnotationsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${HASH}.json`);
  const future = `${target}.future`;
  const store = createStore(HASH, { filePath: "/x/y.md" });

  // Cycle 1: a NEWER Tandem left a v2 envelope carrying the user's only notes.
  await fs.writeFile(target, v2Envelope("USER-NOTE-FROM-CYCLE-1"), "utf-8");
  await store.load();
  console.log("after downgrade #1: .future =", JSON.parse(await fs.readFile(future, "utf-8")).annotations[0].id);

  // Upgrade, edit again, downgrade again.
  await fs.writeFile(target, v2Envelope("CYCLE-2"), "utf-8");
  await store.load();
  const parked = JSON.parse(await fs.readFile(future, "utf-8")).annotations[0].id;
  console.log("after downgrade #2: .future =", parked);
  const siblings = (await fs.readdir(dir)).filter((f) => f.includes(".future"));
  console.log("all .future* files:", siblings);
  console.log(parked === "USER-NOTE-FROM-CYCLE-1" ? "PRESERVED" : "CYCLE-1 PARKED COPY DESTROYED");
}
main();
