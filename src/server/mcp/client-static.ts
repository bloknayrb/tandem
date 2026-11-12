/**
 * Serves the built client: the static files and the SPA fallback.
 *
 * **Tandem's page cannot be loaded inside another page (#2404), in every
 * build.** Every response from this mount carries
 * `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
 * as response HEADERS — a `<meta>` tag cannot carry `frame-ancestors`. They are
 * set by one middleware in front of the static handler rather than per file, so
 * the static `index.html`, the SPA fallback, a `HEAD` and a conditional request
 * answered 304 all carry them; that every asset does too is harmless.
 *
 * Why it matters: a page on another loopback port could frame Tandem's own
 * page, and whatever that framed page did (open the notification stream, send
 * a request) carried Tandem's own origin. The local-model settings are now
 * changed only from Tandem's own window, and a framed copy is not that.
 *
 * What it does not do: stop a pop-up or a top-level navigation to Tandem's
 * page (those load it as an ordinary window), or cover the Vite dev server and
 * the desktop app, neither of which is served from here — a release desktop
 * build loads the client through Tauri's asset protocol.
 *
 * No `Access-Control-Allow-Origin` is set here (CLAUDE.md Critical Rule 8),
 * and no general header library is involved. The `<meta>` CSP in `index.html`
 * is separate and unchanged; a browser applies both.
 *
 * Mount it AFTER every `/mcp`, `/api`, `/health` and channel route: the static
 * handler falls through for paths it does not find and the fallback answers
 * every remaining GET with `index.html`.
 */

import { join } from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";

export const FRAME_ANCESTORS_CSP = "frame-ancestors 'none'";

/** Sets the two framing headers. Exported for the test of the mount. */
export function refuseFraming(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", FRAME_ANCESTORS_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

export function mountClient(app: Express, clientDir: string): void {
  app.use(refuseFraming);
  // Express 5 types omit express.static and res.sendFile — they exist at runtime.
  // biome-ignore lint/suspicious/noExplicitAny: see the line above
  app.use((express as any).static(clientDir, { index: "index.html" }));
  // SPA fallback: serve index.html for client-side routes not matched above.
  const indexPath = join(clientDir, "index.html");
  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.get("/{*path}", (_req: Request, res: any) => {
    res.sendFile(indexPath);
  });
}
