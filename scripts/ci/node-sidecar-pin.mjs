#!/usr/bin/env node

/**
 * Is the bundled Node runtime (scripts/node-sidecar-version.mjs) still current
 * on its release line?
 *
 * #1747: the pin sat at 22.17.0 (2025-06-24) for fourteen months while five
 * security releases shipped past it. Nothing noticed, because CI runs
 * `node-version: 22` — the latest — so the tests never exercised the runtime
 * that actually ships to desktop users.
 *
 * **Three outcomes, not two.** A gate that can only pass or fail gets muted by
 * its first flake (#1229), and this one reaches the network. So:
 *
 *   0  the pin is at or above the newest security release on its line
 *   1  the pin is behind — the failure this exists to detect
 *   3  could not evaluate: the fetch failed, the payload was not the release
 *      index, the line has no entries, or the line has gone quiet long enough
 *      that "no newer security release" stops meaning "up to date"
 *
 * That last case is the one worth spelling out. Node 22 leaves maintenance in
 * April 2027. After that no new 22.x security releases appear, so a pure
 * "is anything newer?" check would return 0 forever against an unsupported
 * runtime — indistinguishable from being current, which is the quietest form of
 * the #1229 failure. `LINE_STALE_MONTHS` converts that silence into a verdict of
 * "ask a human" rather than a verdict of "fine".
 *
 * The job that runs this is ADVISORY (it is not in the required set): it reaches
 * the network, and a nodejs.org outage must not block merges. Its shape is
 * pinned from inside `check` by tests/scripts/node-sidecar-pin-wiring.test.ts,
 * per ADR-051.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_NODE_VERSION } from "../node-sidecar-version.mjs";

export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";

export const EXIT_OK = 0;
export const EXIT_BEHIND = 1;
export const EXIT_CANNOT_EVALUATE = 3;

/**
 * How long the pinned major line may go without ANY release before this reports
 * "cannot evaluate" instead of "current". Node's LTS lines ship roughly monthly
 * while supported, so nine months of silence means the line is over, not calm.
 */
export const LINE_STALE_MONTHS = 9;

/** Numeric semver compare. Never string compare: "22.9.0" > "22.23.2" lexically. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const stripV = (v) => (typeof v === "string" && v.startsWith("v") ? v.slice(1) : v);

/**
 * Pure verdict, given a pinned version and a parsed release index. Separated
 * from the fetch so the wiring test can drive every branch — but note the fetch
 * itself is injected rather than hidden in main(), so the CANNOT_EVALUATE path
 * is testable too rather than resting on someone having once broken the URL by
 * hand.
 */
export function evaluatePin({ pinned, index, now = new Date() }) {
  if (!Array.isArray(index)) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      message: "Release index is not an array — cannot evaluate.",
    };
  }
  const major = pinned.split(".")[0];
  const line = index.filter(
    (entry) =>
      entry &&
      typeof entry.version === "string" &&
      stripV(entry.version).split(".")[0] === major &&
      /^\d+\.\d+\.\d+$/.test(stripV(entry.version)),
  );
  if (line.length === 0) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      message: `Release index carries no v${major}.x entries — cannot evaluate.`,
    };
  }

  const newest = line
    .map((e) => stripV(e.version))
    .sort(compareVersions)
    .at(-1);

  const newestDate = line
    .map((e) => Date.parse(e.date ?? ""))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
    .at(-1);
  if (newestDate !== undefined) {
    const monthsQuiet = (now.getTime() - newestDate) / (1000 * 60 * 60 * 24 * 30.44);
    if (monthsQuiet > LINE_STALE_MONTHS) {
      return {
        code: EXIT_CANNOT_EVALUATE,
        message:
          `The v${major}.x line has had no release in ${monthsQuiet.toFixed(1)} months ` +
          `(newest ${newest}). Past end-of-life, "nothing newer" stops meaning "up to date": ` +
          "decide whether to move the sidecar to a supported line.",
      };
    }
  }

  const behind = line
    .filter((e) => e.security === true)
    .map((e) => stripV(e.version))
    .filter((v) => compareVersions(pinned, v) < 0)
    .sort(compareVersions);

  if (behind.length > 0) {
    return {
      code: EXIT_BEHIND,
      message:
        `Bundled Node is pinned at ${pinned}, behind ${behind.length} security ` +
        `release(s) on the ${major}.x line: ${behind.join(", ")}. ` +
        `Newest ${major}.x is ${newest}. Update DEFAULT_NODE_VERSION and the ` +
        "hashes in scripts/node-sidecar-version.mjs.",
    };
  }

  return {
    code: EXIT_OK,
    message: `Bundled Node ${pinned} is current on the ${major}.x line (newest ${newest}).`,
  };
}

async function fetchIndex(url = NODE_INDEX_URL) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return await resp.json();
}

export async function main({ pinned = DEFAULT_NODE_VERSION, load = fetchIndex } = {}) {
  let index;
  try {
    index = await load();
  } catch (err) {
    // Cannot evaluate is deliberately NOT a pass. A network failure that
    // reported success would make this gate mute itself the first time
    // nodejs.org hiccuped.
    console.error(`::warning::node-sidecar-pin: could not read the release index: ${err.message}`);
    return EXIT_CANNOT_EVALUATE;
  }

  const { code, message } = evaluatePin({ pinned, index });
  if (code === EXIT_BEHIND) console.error(`::error::${message}`);
  else if (code === EXIT_CANNOT_EVALUATE) console.error(`::warning::${message}`);
  else console.log(message);
  return code;
}

// Only run when invoked as a script, so the wiring test can import the exports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `process.exitCode` rather than `process.exit(code)`: exiting abruptly from
  // inside the fetch's promise chain trips a libuv assertion on Windows
  // (`!(handle->flags & UV_HANDLE_CLOSING)`) and the shell then sees 127 --
  // a false red that looks nothing like this gate's own verdicts.
  main().then((code) => {
    process.exitCode = code;
  });
}
