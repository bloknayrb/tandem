import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REASON_POLICY,
  REASON_STATUS_COPY,
} from "../../src/client/components/integration-target-card-reason.js";
import type { EntryValidationStatus } from "../../src/shared/integrations/contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const producerPath = resolve(repoRoot, "src/server/integrations/existing-config.ts");
const contractPath = resolve(repoRoot, "src/shared/integrations/contract.ts");
const producerSource = readFileSync(producerPath, "utf-8");
const contractSource = readFileSync(contractPath, "utf-8");

/** `export type EntryValidationStatus = | "a" | "b";` -> ["a", "b"]. */
function unionMembers(source: string): string[] {
  const start = source.indexOf("export type EntryValidationStatus =");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).sort();
}

interface Producer {
  status: string;
  /** True when the `reason:` value is a template literal containing `${`. */
  interpolating: boolean;
  /** Offset within the scanned function body, for branch-position checks. */
  index: number;
}

/**
 * Every `reason:` producer is `status: "...", reason: <string>` where the
 * string is either double-quoted (always literal) or a backtick template
 * (literal only when it has no `${`). No producer's literal text contains a
 * backtick, so `[^`]*` is a safe template-body match.
 */
function scanProducers(body: string): Producer[] {
  const pattern = /status:\s*"([^"]+)",\s*reason:\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  const out: Producer[] = [];
  for (const match of body.matchAll(pattern)) {
    const template = match[3];
    out.push({
      status: match[1] as string,
      interpolating: template !== undefined && template.includes("${"),
      index: match.index,
    });
  }
  return out;
}

function functionBody(source: string, name: string, nextName: string | undefined): string {
  const start = source.indexOf(`export function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end =
    nextName === undefined ? source.length : source.indexOf(`\nexport function ${nextName}`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * #1422 guard. `IntegrationTargetCard.svelte` decides how much of an
 * `EntryValidation.reason` to show with a PER-STATUS policy
 * (`integration-target-card-reason.ts`), and two of those policies —
 * `verbatim` for `invalid-shape`, and the non-npx half of `argument-count` —
 * render the producer's string byte-for-byte. That is only safe while those
 * producers stay free of interpolation from the user's own config file.
 *
 * So this scans the real source of BOTH validators (the card only feeds it
 * `tandemValidation` today, but the policy is producer-agnostic and
 * `validateChannelEntry` is the one #1422's body actually quotes) and asserts
 * the assumption the policy is written on, rather than asserting a hand-copied
 * list of strings. The exact-string allowlist this replaced had the opposite
 * failure mode: rewording a safe reason silently reverted that card to generic
 * copy, with nothing red anywhere.
 */
describe("the per-status render policy matches existing-config.ts's producers (#1422)", () => {
  const tandemBody = functionBody(producerSource, "validateTandemEntry", "validateChannelEntry");
  const channelBody = functionBody(producerSource, "validateChannelEntry", undefined);
  const tandemProducers = scanProducers(tandemBody);
  const channelProducers = scanProducers(channelBody);
  const all = [...tandemProducers, ...channelProducers];

  it("the scan found producers of both kinds in both validators (a vacuous pass would hide a broken pattern)", () => {
    expect(tandemProducers.length).toBeGreaterThanOrEqual(5);
    expect(channelProducers.length).toBeGreaterThanOrEqual(3);
    expect(all.some((p) => p.interpolating)).toBe(true);
    expect(all.some((p) => !p.interpolating)).toBe(true);
  });

  // The policy renders `invalid-shape` verbatim on the strength of it being a
  // fixed literal in both validators. If one ever starts interpolating, the
  // card would paint that payload with no other test noticing.
  it("no invalid-shape producer interpolates, because the policy renders it verbatim", () => {
    const offenders = all.filter((p) => p.status === "invalid-shape" && p.interpolating);
    expect(offenders).toEqual([]);
    expect(REASON_POLICY["invalid-shape"]).toBe("verbatim");
  });

  // Only `invalid-command` is rendered verbatim DESPITE interpolating, and
  // that is the deliberate decision #1422 turns on: the interpolated value is
  // a command path, no more sensitive than the `configPath` the same card
  // already prints one line below.
  it("the only interpolating producer under a verbatim policy is invalid-command", () => {
    const verbatimInterpolating = [
      ...new Set(
        all
          .filter(
            (p) =>
              p.interpolating && REASON_POLICY[p.status as EntryValidationStatus] === "verbatim",
          )
          .map((p) => p.status),
      ),
    ];
    expect(verbatimInterpolating).toEqual(["invalid-command"]);
  });

  // `argument-count` reduces to expected-tuple + count ONLY on the npx branch
  // (`entry.command === "npx"`); every other invalid-args producer is rendered
  // verbatim. So the interpolating one must be the npx one, and it must be the
  // only interpolating invalid-args producer anywhere.
  it("the single interpolating invalid-args producer lives inside the npx branch", () => {
    const interpolatingArgs = all.filter((p) => p.status === "invalid-args" && p.interpolating);
    expect(interpolatingArgs).toHaveLength(1);
    const npxBranch = tandemBody.indexOf('entry.command === "npx"');
    expect(npxBranch).toBeGreaterThan(-1);
    const producer = tandemProducers.find((p) => p.status === "invalid-args" && p.interpolating);
    expect(producer).toBeDefined();
    expect(producer?.index).toBeGreaterThan(npxBranch);
    expect(REASON_POLICY["invalid-args"]).toBe("argument-count");
  });

  // `invalid-url` is never rendered raw; the card rebuilds scheme+host+port
  // from the parsed entry url. Pinned so a future "it's just a URL, show it"
  // simplification has to argue with a test.
  it("invalid-url is never rendered verbatim", () => {
    expect(REASON_POLICY["invalid-url"]).toBe("url-authority");
  });

  it("every status a producer can emit has a policy and fallback copy", () => {
    for (const producer of all) {
      expect(REASON_POLICY[producer.status as keyof typeof REASON_POLICY]).toBeDefined();
      expect(REASON_STATUS_COPY[producer.status as keyof typeof REASON_STATUS_COPY]).toBeDefined();
    }
  });
});

/**
 * FINDING 2 — union drift. `EntryValidationStatus` is declared TWICE:
 * `server/integrations/existing-config.ts` produces it, `shared/integrations/
 * contract.ts` is what the client types against, and nothing structurally ties
 * them. Add a status server-side without mirroring it and the client's
 * `Record` lookups miss — before #1422 the card was immune because it printed
 * a fixed sentence; now it renders a status-keyed string, so a miss would
 * render the literal text `undefined`.
 *
 * `renderValidationReason` has a runtime fallback for that (tested in
 * `integration-target-card-reason.test.ts`), but a fallback alone leaves the
 * drift undetected forever. This is the half that makes it visible.
 */
describe("EntryValidationStatus parity across its two declarations (#1422 FINDING 2)", () => {
  it("the server producer and the shared contract declare the same members", () => {
    expect(unionMembers(contractSource)).toEqual(unionMembers(producerSource));
  });

  it("the client's policy and copy tables cover exactly those members", () => {
    const members = unionMembers(contractSource);
    expect(Object.keys(REASON_POLICY).sort()).toEqual(members);
    expect(Object.keys(REASON_STATUS_COPY).sort()).toEqual(members);
  });
});
