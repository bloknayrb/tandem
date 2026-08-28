import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enforceLoopbackMutation } from "../../src/server/mcp/api-routes.js";
import {
  API_ANNOTATION_REPLY,
  API_APPLY_CHANGES,
  API_CHANNEL_AWARENESS,
  API_CHANNEL_ERROR,
  API_CHANNEL_PERMISSION,
  API_CHANNEL_PERMISSION_VERDICT,
  API_CHANNEL_REPLY,
  API_CHAT,
  API_CLOSE,
  API_CONVERT,
  API_INFO,
  API_OPEN,
  API_REMOVE_ANNOTATION,
  API_ROTATE_TOKEN,
  API_SAVE,
  API_UPLOAD,
} from "../../src/shared/api-paths.js";

/**
 * #1320 — `/api` is loopback-only for every method except GET/HEAD/OPTIONS.
 *
 * The harness deliberately mounts the invariant the way `server.ts` does —
 * `app.use("/api", …)` with routes registered at their FULL `/api/...` paths on
 * the root app — because that is the only shape in which the defect this test
 * exists to catch is reachable. Express strips the mount prefix, so inside the
 * middleware `req.path` reads `/channel-reply`, not `/api/channel-reply`. A unit
 * test that calls `enforceLoopbackMutation({ path: "/api/channel-reply" }, …)`
 * directly passes green while every Cowork channel POST 403s in production.
 *
 * The carve-out cases below are therefore not decoration: nothing in CI
 * exercises the channel shim against a non-loopback host, and `channel/run.ts`
 * logs a 403 to stderr and continues, so a broken carve-out would surface only
 * as a Cowork user reporting silence. They are the only detector there is.
 */

/** Paths that must remain reachable by a non-loopback caller (Cowork transport). */
const CARVE_OUTS = [
  { method: "POST", path: API_CHANNEL_AWARENESS },
  { method: "POST", path: API_CHANNEL_ERROR },
  { method: "POST", path: API_CHANNEL_REPLY },
  { method: "POST", path: API_CHANNEL_PERMISSION },
  { method: "POST", path: API_CHANNEL_PERMISSION_VERDICT },
  { method: "DELETE", path: API_CHAT },
] as const;

/** Mutating routes that had no gate at all before #1320. */
const PREVIOUSLY_UNGATED = [
  API_OPEN,
  API_SAVE,
  API_CONVERT,
  API_UPLOAD,
  API_CLOSE,
  API_APPLY_CHANGES,
  API_ANNOTATION_REPLY,
  API_REMOVE_ANNOTATION,
  API_ROTATE_TOKEN,
] as const;

/** Set by each request via the `x-test-peer` header; undefined means "fail closed". */
let baseUrl = "";
let server: ReturnType<Application["listen"]>;
const reached: string[] = [];

beforeAll(async () => {
  const app = express();

  // Stand in for the real peer address. A server listening on 127.0.0.1 always
  // sees a loopback peer — `server-security-invariants.test.ts` records that you
  // cannot fake one over a real socket — so the address is overridden here,
  // before the invariant runs, exactly where the kernel would have set it.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const peer = req.headers["x-test-peer"];
    Object.defineProperty(req.socket, "remoteAddress", {
      value: typeof peer === "string" && peer !== "" ? peer : undefined,
      configurable: true,
    });
    next();
  });

  app.use("/api", enforceLoopbackMutation);

  // Registered at full `/api/...` paths on the root app — the same way every
  // registrar in `server.ts` does it. Recording reach rather than asserting on
  // status alone: a 403 with the handler already run is not a gate.
  const record = (label: string) => (_req: Request, res: Response) => {
    reached.push(label);
    res.status(200).json({ ok: true });
  };
  for (const path of PREVIOUSLY_UNGATED) {
    app.post(path, record(`POST ${path}`));
  }
  for (const { method, path } of CARVE_OUTS) {
    if (method === "DELETE") {
      app.delete(path, record(`DELETE ${path}`));
    } else {
      app.post(path, record(`POST ${path}`));
    }
  }
  app.get(API_INFO, record(`GET ${API_INFO}`));
  app.options(API_OPEN, (_req: Request, res: Response) => res.sendStatus(204));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(
  method: string,
  path: string,
  peer: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: peer === undefined ? {} : { "x-test-peer": peer },
  });
  const text = await res.text();
  // Express's 404 handler serves HTML, so parsing unconditionally would turn a
  // "the router declined it" result into a SyntaxError.
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const LAN = "192.168.1.50";

describe("#1320 /api loopback invariant", () => {
  it("refuses every previously-ungated mutator from a LAN peer, without reaching the handler", async () => {
    for (const path of PREVIOUSLY_UNGATED) {
      reached.length = 0;
      const { status, body } = await call("POST", path, LAN);
      expect(status, `POST ${path}`).toBe(403);
      expect(body).toMatchObject({ error: "FORBIDDEN", code: "BAD_ORIGIN" });
      // The assertion that matters. A 403 returned after the handler already
      // opened a file, wrote a converted document or swapped the auth token
      // would satisfy a status-only test while fixing nothing.
      expect(reached, `handler must not run for ${path}`).toEqual([]);
    }
  });

  it("still admits every carve-out from a LAN peer", async () => {
    for (const { method, path } of CARVE_OUTS) {
      reached.length = 0;
      const { status } = await call(method, path, LAN);
      expect(status, `${method} ${path} is the Cowork transport`).toBe(200);
      expect(reached).toEqual([`${method} ${path}`]);
    }
  });

  it("admits carve-outs written with a trailing slash or mixed case", async () => {
    // Express routes non-strictly and case-insensitively, so both forms reach
    // the handler. An exact-set lookup would miss them and fail closed — not a
    // bypass, but a Cowork break for a caller that did nothing wrong.
    for (const variant of [`${API_CHANNEL_REPLY}/`, API_CHANNEL_REPLY.toUpperCase()]) {
      const { status } = await call("POST", variant, LAN);
      expect(status, variant).toBe(200);
    }
  });

  it("admits every method from a loopback peer, in both IPv4 and IPv6 forms", async () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const { status } = await call("POST", API_OPEN, peer);
      expect(status, peer).toBe(200);
    }
  });

  it("leaves GET and OPTIONS alone for a LAN peer", async () => {
    // Reads keep their per-route posture (scrub or hand-rolled 403); preflight
    // must survive or CORS breaks before the per-route middleware is reached.
    expect((await call("GET", API_INFO, LAN)).status).toBe(200);
    expect((await call("OPTIONS", API_OPEN, LAN)).status).toBe(204);
  });

  it("fails closed when the peer address is unknown", async () => {
    const { status } = await call("POST", API_OPEN, undefined);
    expect(status).toBe(403);
  });

  it("exempts a carve-out by METHOD AND path, not by path alone", async () => {
    // `DELETE /api/chat` is the carve-out. A path-keyed set would also exempt
    // `POST /api/chat` — no such route today, but it is the obvious next one,
    // and it would inherit LAN-write access with nothing able to notice. A 404
    // would mean the gate passed and the router refused; 403 is the gate.
    expect((await call("POST", API_CHAT, LAN)).status).toBe(403);
    expect((await call("DELETE", API_CHAT, LAN)).status).toBe(200);
  });

  it("never serves a doubled-slash path that skips the mount entirely", async () => {
    // `app.use("/api", …)` does not match `//api/open` — the middleware never
    // runs, and so does `app.use("/api", authMiddleware)` in production. Today
    // the router declines it too, so it 404s and the two disagreements cancel.
    // That is a coincidence, not a guarantee: any normalizing hop added later
    // (reverse proxy, strict-routing change) turns it into an auth AND loopback
    // bypass. Assert the outcome, so the coincidence cannot break quietly.
    for (const path of [`/${API_OPEN}`, `//${API_OPEN}`]) {
      const { status } = await call("POST", path, LAN);
      expect(status, path).not.toBe(200);
    }
  });
});

describe("#1320 the invariant is actually mounted", () => {
  // The harness above proves the middleware behaves. This proves production
  // wires it — without which every assertion above tests a module nothing calls.
  const serverSrc = readFileSync(
    fileURLToPath(new URL("../../src/server/mcp/server.ts", import.meta.url)),
    "utf-8",
  );

  it("mounts enforceLoopbackMutation under /api, after auth and before EVERY registrar", () => {
    const auth = serverSrc.indexOf('app.use("/api", authMiddleware)');
    const invariant = serverSrc.indexOf('app.use("/api", enforceLoopbackMutation)');
    expect(invariant, "server.ts must mount enforceLoopbackMutation under /api").toBeGreaterThan(
      -1,
    );
    expect(invariant).toBeGreaterThan(auth);

    // Every registrar, **derived from the file rather than listed here**.
    //
    // This used to be a hardcoded list of the five that existed when it was
    // written. That closes the direction it names below — the mount sliding
    // *down* past a known registrar — and leaves the mirror image wide open: a
    // sixth `registerAnythingRoutes(app, …)` added *above* line 691 mounts its
    // routes ungated and this test stays green, because a name absent from the
    // list is never looked for. The guard's bug is its scope, not its matching.
    // Deriving the list is what makes "before EVERY registrar" mean every one.
    const registrars = [...serverSrc.matchAll(/\bregister\w*Routes\s*\(/g)];
    expect(
      registrars.length,
      "the registrar scan found nothing — it is broken, not server.ts. Zero " +
        "registrars satisfies the loop below perfectly.",
    ).toBeGreaterThanOrEqual(5);
    for (const known of ["registerApiRoutes(", "registerChannelRoutes("]) {
      expect(
        registrars.some((m) => m[0].replace(/\s+/g, "") === known),
        `the scan must still find ${known} — a regex that stopped matching would ` +
          "leave this assertion vacuously true",
      ).toBe(true);
    }
    for (const m of registrars) {
      expect(m.index, `${m[0].trim()} must run after the invariant is mounted`).toBeGreaterThan(
        invariant,
      );
    }

    // The other way to add an ungated route: skip the registrar convention and
    // write the route straight into server.ts above the mount.
    //
    // The first version of this scan looked only for a bare string literal --
    // `app.post("/api/...", ...)`. Measured against server.ts it matched
    // **zero** things, so the loop body never ran and the check was the same
    // zero-of-zero it was written to replace. This project spells every route
    // with a path constant (`app.post(API_OPEN, ...)`, the idiom used ~25 times
    // in api-routes.ts), which is the one spelling that regex could not see.
    //
    // So: literal OR `API_*` identifier, and `use` in the alternation too --
    // `app.use("/api/x", router)` mounts routes just as effectively as
    // `app.post` registers one.
    const DIRECT_ROUTE_RE =
      /\bapp\.(get|post|put|patch|delete|all|use)\(\s*(?:"\/api|'\/api|`\/api|API_[A-Z0-9_]*)/g;

    // A scan over a file that legitimately contains zero matches cannot be
    // controlled by the file. Control the *regex* instead: it has to see each
    // idiom it claims to cover, or a later rewrite can silently narrow it back
    // to what it was without any assertion noticing.
    for (const sample of [
      'app.post("/api/thing", h);',
      "app.post(API_OPEN, h);",
      "app.use('/api/sub', router);",
      "app.get(`/api/x`, h);",
      "app.delete(\n  API_CLOSE,\n  h,\n);",
    ]) {
      expect(
        new RegExp(DIRECT_ROUTE_RE.source).test(sample),
        `the direct-route scan no longer matches \`${sample}\` -- it has narrowed`,
      ).toBe(true);
    }

    // `app.use("/api", authMiddleware)` and the invariant mount itself match the
    // pattern and are *supposed* to sit at or above the mount: they are the
    // middleware chain, not routes. Exempt them by handler name, so anything
    // else mounted on /api above the invariant still reports.
    const MIDDLEWARE_MOUNTS = ["authMiddleware", "enforceLoopbackMutation"];
    for (const m of serverSrc.matchAll(DIRECT_ROUTE_RE)) {
      const tail = serverSrc.slice(m.index, m.index + 120);
      if (MIDDLEWARE_MOUNTS.some((name) => tail.includes(name))) continue;
      expect(
        m.index,
        `a direct ${m[1].toUpperCase()} /api route is registered above the ` +
          "enforceLoopbackMutation mount, so it is ungated",
      ).toBeGreaterThan(invariant);
    }
  });
});
