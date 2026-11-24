/**
 * The stall banner's flag-on facts through the real server (#2358 PR 3b-2e2,
 * the owner's 2026-11-17 answer 3, "Hide while starting, then reword").
 *
 * `routes/health.ts` is tested with stub deps in `health-route.test.ts`; this
 * file drives the real `startMcpServerHttp`, so what is under test is
 * `server.ts`'s wiring: `deliveryRoundsKeyed` (the delivery-round seam, which
 * `index.ts` wires to the ownership flag) and `tandemClaudeWokenAt` (the live
 * supervisor's `wokenAt`, through the launcher wiring's getter).
 *
 * The seam is set directly, as `index.ts` does at boot, rather than through
 * the ownership flag, so this file stubs no `TANDEM_OWNERSHIP` (the reviewed
 * set in `ownership-module-seam.test.ts`). Unset, it is every dark server.
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordWakeForward,
  resetDeliveryStateForTests,
  setDeliveryRoundSeam,
} from "../../src/server/events/delivery-state.js";
import { resetForTesting, subscribe, unsubscribe } from "../../src/server/events/queue.js";
import type { Supervisor } from "../../src/server/launcher/supervisor.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

let httpServer: Server;
let baseUrl: string;
/** What the fake supervisor's `wokenAt` answers; `undefined` = no supervisor. */
let wokenAt: number | null | undefined;
const consumer = (): void => {};

const fakeSupervisor = (): Supervisor | null =>
  wokenAt === undefined ? null : ({ wokenAt: () => wokenAt } as unknown as Supervisor);

beforeEach(async () => {
  resetForTesting();
  resetDeliveryStateForTests();
  setDeliveryRoundSeam(undefined);
  wokenAt = undefined;
  // An external consumer, so an outstanding forward reads `awaiting-poll`
  // rather than `consumer-detached`.
  subscribe(consumer, "external");
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  httpServer = await startMcpServerHttp(port, "127.0.0.1", undefined, undefined, {
    getSupervisor: fakeSupervisor,
    unavailableReason: () => "disabled-by-env",
    startSupervisor: async () => {},
  });
});

afterEach(async () => {
  unsubscribe(consumer);
  setDeliveryRoundSeam(undefined);
  resetDeliveryStateForTests();
  resetForTesting();
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function delivery(): Promise<Record<string, unknown>> {
  const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
    delivery: Record<string, unknown>;
  };
  return body.delivery;
}

function keyRounds(): void {
  setDeliveryRoundSeam({ keyed: () => true, isDocumentOpen: () => true });
}

describe("/health's delivery, the stall banner's flag-on facts, through the real server", () => {
  it("dark (the seam unset): no `keyed`, no woken fact, whatever the supervisor answers", async () => {
    wokenAt = Date.now() + 60_000;
    recordWakeForward(Date.now() - 1_000);
    const d = await delivery();
    expect(d.state).toBe("awaiting-poll");
    expect(d).not.toHaveProperty("keyed");
    expect(d).not.toHaveProperty("tandemClaudeWoken");
  });

  it("keyed: `keyed: true` beside a waiting round, with no supervisor", async () => {
    keyRounds();
    recordWakeForward(Date.now() - 1_000);
    const d = await delivery();
    expect(d.state).toBe("awaiting-poll");
    expect(d.keyed).toBe(true);
    expect(d).not.toHaveProperty("tandemClaudeWoken");
  });

  it("keyed: the live supervisor's wake after the round opened reads woken; one before it does not", async () => {
    keyRounds();
    const opened = Date.now() - 10_000;
    recordWakeForward(opened);
    wokenAt = opened + 1;
    expect(await delivery()).toMatchObject({ keyed: true, tandemClaudeWoken: true });
    wokenAt = opened - 5_000;
    const before = await delivery();
    expect(before.keyed).toBe(true);
    expect(before).not.toHaveProperty("tandemClaudeWoken");
    wokenAt = null;
    expect(await delivery()).not.toHaveProperty("tandemClaudeWoken");
  });
});
