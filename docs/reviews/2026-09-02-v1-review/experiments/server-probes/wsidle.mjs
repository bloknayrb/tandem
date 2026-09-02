import WebSocket from "ws";
const ws = new WebSocket(process.argv[2]);
ws.on("open", () => console.log("OPEN (sending nothing)"));
ws.on("close", (c, r) => { console.log(`CLOSE code=${c} reason=${r?.toString()}`); process.exit(0); });
ws.on("error", (e) => { console.log("ERROR", e.message); process.exit(0); });
setTimeout(() => { console.log("STILL OPEN after 6s, no close"); process.exit(0); }, 6000);
