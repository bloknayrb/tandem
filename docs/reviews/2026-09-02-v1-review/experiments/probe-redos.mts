// #1795. Before the fix this called `searchText(text, "(a+)+$", true)` on the
// main thread. `searchText` is literal-only now, and `docs/` is outside every
// tsconfig, so leaving that call here would silently become a literal search
// for six characters — 0 matches in 0 ms, reading exactly like a pass.
const { searchRegexInWorker, shutdownSearchWorker } = await import(
  "../../../../src/server/mcp/search-worker.ts"
);
const text = "a".repeat(28) + "b";
const t0 = Date.now();
const r = await searchRegexInWorker(text, "(a+)+$");
console.log("regex (a+)+$ on 28 a's + b: elapsed ms =", Date.now() - t0, "result:", JSON.stringify(r).slice(0, 120));
await shutdownSearchWorker();
