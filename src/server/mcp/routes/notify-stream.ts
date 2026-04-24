import type { Request, Response } from "express";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../../shared/constants.js";
import type { TandemNotification } from "../../../shared/types.js";
import { subscribe as subscribeNotifications } from "../../notifications.js";

export function handleNotifyStream(req: Request, res: Response): void {
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

  const unsubscribe = subscribeNotifications((notification: TandemNotification) => {
    try {
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch (err) {
      console.error("[NotifyStream] Write failed, cleaning up:", err);
      cleanup();
    }
  });

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
