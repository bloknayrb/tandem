// A stand-in server that answers /health and /mcp but never prints the
// "MCP session established" line: the probe must report it could not evaluate
// (exit 3), never a pass. Booted through the probe's `--entry` test seam.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("{}");
    return;
  }
  req.resume();
  res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": randomUUID() });
  res.end("{}");
});
server.listen(Number(process.env.TANDEM_MCP_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
