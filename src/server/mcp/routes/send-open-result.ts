import type { Response } from "express";
import { type OpenSuccess, toWireResult } from "../../documents/open.js";

/**
 * Send a successful open to an HTTP caller.
 *
 * The three open routes shipped `res.json({ data: result })`
 * character-for-character before Unit 7b, and the projection this unit adds is
 * the kind of step that compiles perfectly well when you forget it — `res.json`
 * takes `unknown`, so sending the internal `OpenSuccess` straight out would put
 * `kind` on the wire and drop the three booleans every existing client reads,
 * with nothing in this repo going red. Adding the call to each route
 * independently would have been three chances to forget; one helper is one.
 *
 * **Its own module rather than `_shared.ts`, and that is load-bearing.** It
 * started in `_shared.ts` and turned `tests/server/rename-route.test.ts` red:
 * every route imports `_shared.ts` for `errorCodeToHttpStatus` and friends, so
 * one edge into `documents/open.ts` dragged the whole
 * `open.ts -> autosave.ts -> mcp/document-service.ts` graph into the module
 * init of routes with nothing to do with opening documents. A route test that
 * mocks `document-service` then evaluates that mock during the `_shared`
 * import, before its own hoisted `vi.fn()` binding exists — a TDZ error, and
 * one no edit to that test would have made honest. A leaf module every route
 * imports has to stay a leaf.
 *
 * `tandem_open` deliberately does NOT route through here: it is on the MCP
 * wire, not the HTTP one, and attaches `openResultMessage`. Its projection is
 * pinned by the same census as this one
 * (`tests/server/open-result-consumption.test.ts`).
 */
export function sendOpenResult(res: Response, result: OpenSuccess): void {
  res.json({ data: toWireResult(result) });
}
