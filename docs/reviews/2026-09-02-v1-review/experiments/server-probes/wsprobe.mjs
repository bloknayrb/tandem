import WebSocket from "ws";
const [,, url, mbStr] = process.argv;
const mb = Number(mbStr);
const buf = Buffer.alloc(mb * 1024 * 1024, 0x41);
const ws = new WebSocket(url, { maxPayload: 200 * 1024 * 1024 });
let done = false;
const finish = (msg) => { if (done) return; done = true; console.log(msg); try { ws.terminate(); } catch {} process.exit(0); };
ws.on("open", () => {
  console.log(`OPEN ${url} sending ${mb} MiB binary frame`);
  ws.send(buf, { binary: true }, (err) => console.log("send cb err=", err ? String(err) : "none"));
});
ws.on("message", (d) => console.log("MSG len", d.length));
ws.on("close", (code, reason) => finish(`CLOSE code=${code} reason=${reason?.toString().slice(0,120)}`));
ws.on("error", (e) => finish(`ERROR ${e.message}`));
ws.on("unexpected-response", (_q, res) => finish(`UNEXPECTED ${res.statusCode}`));
setTimeout(() => finish("TIMEOUT (still open, no close)"), 15000);
