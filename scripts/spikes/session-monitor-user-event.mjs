/**
 * Fixture-only user chat injector for session_monitor_acceptance.py.
 *
 * Connects to the isolated Tandem control room with that server generation,
 * writes one user-authored chat item, waits for the update to flush, and exits.
 * It never reads or writes Claude configuration.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

const [httpBase, wsBase, eventId, eventText] = process.argv.slice(2);
if (!httpBase || !wsBase || !eventId || !eventText) {
  process.stderr.write(
    "usage: node session-monitor-user-event.mjs <http-base> <ws-base> <event-id> <event-text>\n",
  );
  process.exit(2);
}

const httpUrl = new URL(httpBase);
const wsUrl = new URL(wsBase);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (
  httpUrl.protocol !== "http:" ||
  wsUrl.protocol !== "ws:" ||
  !loopbackHosts.has(httpUrl.hostname) ||
  !loopbackHosts.has(wsUrl.hostname)
) {
  throw new Error("acceptance injector endpoints must use loopback HTTP and WebSocket URLs");
}

const infoResponse = await fetch(new URL("/api/info", httpUrl));
if (!infoResponse.ok) {
  throw new Error(`/api/info failed: ${infoResponse.status}`);
}
const info = await infoResponse.json();
if (typeof info.generationId !== "string" || info.generationId.length === 0) {
  throw new Error("isolated server returned no generationId");
}

const doc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: wsBase,
  name: "__tandem_ctrl__",
  document: doc,
  token: info.generationId,
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("control-room sync timed out")), 10_000);
    provider.on("synced", ({ state }) => {
      if (!state) return;
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", () => {
      clearTimeout(timer);
      reject(new Error("control-room authentication failed"));
    });
  });
  doc.transact(() => {
    doc.getMap("chat").set(eventId, {
      id: eventId,
      author: "user",
      text: eventText,
      timestamp: Date.now(),
    });
  }, "tandem-acceptance-user");
  await new Promise((resolve) => setTimeout(resolve, 750));
  process.stdout.write(`${JSON.stringify({ eventId, eventText })}\n`);
} finally {
  provider.destroy();
  doc.destroy();
}
