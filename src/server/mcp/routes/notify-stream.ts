import type { Request, Response } from "express";
import {
  CHANNEL_SSE_KEEPALIVE_MS,
  TAURI_HOSTNAME,
  TAURI_LINUX_ORIGIN,
} from "../../../shared/constants.js";
import type { TandemNotification } from "../../../shared/types.js";
import { subscribe as subscribeNotifications } from "../../notifications.js";
import { getStartupNotices, markStartupNoticeDelivered } from "../../startup-notices.js";

/**
 * Was this stream opened by Tandem's own window, as far as a browser vouches
 * for it? (#2404.) The route is an unauthenticated loopback GET with no Origin
 * gate — a page on another `127.0.0.1` port can open it, with `EventSource` or
 * even an `<img>` — so "a stream received the notice" does not mean the user
 * was shown it. This is the narrower test, used only to decide whether a
 * notice counts as seen; every stream still receives every notice.
 *
 *  - the desktop WebView: its exact origin. Not unforgeable — a browser
 *    resolves `*.localhost` to loopback, so content served on port 80 of this
 *    computer can present it — but no page on any other port can;
 *  - the page Tandem serves: a same-origin request, which a browser marks
 *    `Sec-Fetch-Site: same-origin` (and, when it sends an `Origin` at all,
 *    gives this server's own host). A cross-origin page on another port is
 *    `same-site`, never `same-origin`.
 *
 * This identifies Tandem's PAGE, not the user's window. Tandem's served page
 * can no longer be framed (#2404: `frame-ancestors 'none'`, client-static.ts),
 * but a pop-up or a top-level navigation still loads it, and the stream that
 * page opens passes this test. That is acceptable for what this test now
 * decides — whether the START-UP notice counts as told — because a page on
 * another port can no longer create the mismatch that notice reports: the two
 * settings routes accept a write only from Tandem's own window. The one
 * exception is the development allowance (`TANDEM_MODELS_DEV_ORIGIN`): a page
 * on the allowed port can make a change and then pop up Tandem's page. The
 * register entry (#2410, docs/security.md) says so.
 *
 * Anything else — no `Sec-Fetch-Site`, the Vite dev origin, another loopback
 * port — is not counted, which costs a repeated notice and never a missed one.
 * A local process can forge all of this; it can also write the files itself,
 * and is outside what a notice can bound.
 */
export function isTandemOwnWindow(req: Request): boolean {
  // Read defensively: anything that is not a well-formed request is simply not
  // Tandem's own window.
  const headers = req.headers ?? {};
  const origin = headers.origin;
  if (typeof origin === "string") {
    if (origin === TAURI_LINUX_ORIGIN) return true;
    if (origin === `http://${TAURI_HOSTNAME}` || origin === `https://${TAURI_HOSTNAME}`) {
      return true;
    }
    const host = headers.host;
    if (typeof host !== "string" || origin !== `http://${host}`) return false;
  }
  return headers["sec-fetch-site"] === "same-origin";
}

export function handleNotifyStream(req: Request, res: Response): void {
  const ownWindow = isTandemOwnWindow(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(": connected\n\n");

  function cleanup(): void {
    clearInterval(keepalive);
    unsubscribe();
  }

  const unsubscribe = subscribeNotifications(
    (notification: TandemNotification) => {
      try {
        res.write(`data: ${JSON.stringify(notification)}\n\n`);
      } catch (err) {
        console.error("[NotifyStream] Write failed, cleaning up:", err);
        cleanup();
      }
    },
    { ownWindow },
  );

  // Startup notices were raised before any client could connect, so each new
  // stream gets them here rather than through the subscription (startup-notices.ts).
  for (const notice of getStartupNotices()) {
    try {
      res.write(`data: ${JSON.stringify(notice)}\n\n`);
      // Some notices need to know they were sent to Tandem's own window, not
      // merely to some client of this stream (#2404).
      if (ownWindow) markStartupNoticeDelivered(notice);
    } catch (err) {
      console.error("[NotifyStream] Startup notice write failed:", err);
      break;
    }
  }

  const keepalive = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    } catch (err) {
      console.error("[NotifyStream] Keepalive write failed, cleaning up:", err);
      cleanup();
    }
  }, CHANNEL_SSE_KEEPALIVE_MS);

  req.on("close", () => {
    cleanup();
    console.error("[NotifyStream] Client disconnected from /api/notify-stream");
  });

  console.error("[NotifyStream] Client connected to /api/notify-stream");
}
