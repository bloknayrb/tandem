import * as Y from "yjs";
// Experiment 1: concurrent map.set on same key from two peers — who wins?
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}
for (const trial of [1, 2, 3]) {
  const server = new Y.Doc(); const browser = new Y.Doc();
  server.getMap("annotations").set("a1", { id: "a1", status: "pending", content: "orig", rev: 1 });
  sync(server, browser);
  // concurrent: server edits content (Claude editAnnotation), browser accepts
  server.transact(() => server.getMap("annotations").set("a1", { id: "a1", status: "pending", content: "edited", rev: 2 }), "mcp");
  browser.transact(() => browser.getMap("annotations").set("a1", { id: "a1", status: "accepted", content: "orig", rev: 1 }), "browser");
  sync(server, browser);
  const s = server.getMap("annotations").get("a1") as any; const b = browser.getMap("annotations").get("a1") as any;
  console.log(`trial ${trial}: server clientID ${server.clientID} > browser ${browser.clientID}? ${server.clientID > browser.clientID}; converged status=${s.status} content=${s.content} (browser sees ${b.status}/${b.content}); equal=${JSON.stringify(s)===JSON.stringify(b)}`);
}
// Experiment 2: server deletes key (force reload clear) while browser concurrently sets it (accept)
{
  const server = new Y.Doc(); const browser = new Y.Doc();
  server.getMap("annotations").set("a1", { id: "a1", status: "pending", rev: 1 });
  sync(server, browser);
  server.transact(() => server.getMap("annotations").delete("a1"), "internal");
  browser.transact(() => browser.getMap("annotations").set("a1", { id: "a1", status: "accepted", rev: 1 }), "browser");
  sync(server, browser);
  console.log("exp2 after concurrent delete+set: server has a1 =", server.getMap("annotations").has("a1"), JSON.stringify(server.getMap("annotations").get("a1")));
}
