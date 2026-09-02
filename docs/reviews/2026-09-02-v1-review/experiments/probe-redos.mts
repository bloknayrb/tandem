const { searchText } = await import("../../../../src/server/mcp/navigation.ts");
const text = "a".repeat(28) + "b";
const t0 = Date.now();
const r = searchText(text, "(a+)+$", true);
console.log("regex (a+)+$ on 28 a's + b: elapsed ms =", Date.now() - t0, "result:", JSON.stringify(r).slice(0, 120));
