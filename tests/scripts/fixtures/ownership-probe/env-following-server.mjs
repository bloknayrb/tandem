// A stand-in for dist/server/index.js, booted by scripts/ci/ownership-bundle-probe.mjs
// through its `--entry` test seam (tests/scripts/ownership-flag-on-wiring.test.ts).
//
// It behaves like a bundle WITHOUT the ownership define: it hashes session ids
// in its log line exactly when TANDEM_OWNERSHIP=1 is in its environment. So the
// probe's `--expect off` must FAIL against it (the probe gives the child the
// variable) and `--expect on` must FAIL too (the probe gives it none). It also
// refuses to start unless the probe isolated its home, so a probe that started
// inheriting the parent's environment fails here.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const home = process.env.HOME ?? "";
if (!home.includes("tandem-ownership-probe-") || process.env.TANDEM_AUTH_TOKEN !== undefined) {
  process.stderr.write(`fixture: environment not isolated (HOME=${home})\n`);
  process.exit(2);
}
const hashed = process.env.TANDEM_OWNERSHIP === "1";
const show = (id) =>
  hashed ? `#${createHash("sha256").update(id).digest("hex").slice(0, 8)}` : id;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  if (req.method === "POST" && req.url === "/mcp") {
    const sessionId = randomUUID();
    const claude = String(req.headers["x-claude-session-id"] ?? "");
    process.stderr.write(
      `[Tandem] MCP session established: ${show(sessionId)} (claude session ${show(claude)}) — 1 live\n`,
    );
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": sessionId });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(Number(process.env.TANDEM_MCP_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
