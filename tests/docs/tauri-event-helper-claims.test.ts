import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./rust-sources.js";

/**
 * #1959 review — `src/client/utils/tauri-event.ts`'s docblock used to claim
 * that "the three call sites" routed through `listenTauriEvent`. Two did, and
 * six hand-rolled listen/cancel chains against the same dynamic import were
 * left in place by the same commit. That matters because the helper carries a
 * guard the copies lack (it re-checks `cancelled` inside the handler): a
 * maintainer fixing that class of bug reads the docblock, patches one file and
 * ships believing every Tauri listener is covered.
 *
 * So the docblock now enumerates the sites that are NOT covered, and this is
 * what keeps that enumeration true. Nothing else can: the claim is prose, so
 * `npm run typecheck` and every unit test stay green however far it drifts.
 *
 * It fails closed in both directions — a new file reaching for
 * `@tauri-apps/api/event` must be named or migrated, and a migrated file must
 * be struck from the list.
 */

const CLIENT_DIR = join(REPO_ROOT, "src", "client");
const HELPER_REL = "src/client/utils/tauri-event.ts";
const EVENT_MODULE = "@tauri-apps/api/event";

/** Every `.ts`/`.svelte` file under `src/client`, repo-relative, forward slashes. */
function clientFiles(dir = CLIENT_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...clientFiles(abs));
    else if (/\.(ts|svelte)$/.test(entry.name))
      out.push(
        abs
          .slice(REPO_ROOT.length + 1)
          .split(sep)
          .join("/"),
      );
  }
  return out;
}

const files = clientFiles();
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
const docblock = read(HELPER_REL).slice(0, read(HELPER_REL).indexOf("*/") + 2);

describe("listenTauriEvent's docblock", () => {
  it("names exactly the sites that route through the helper", () => {
    const users = files
      .filter((rel) => rel !== HELPER_REL && read(rel).includes("listenTauriEvent"))
      .sort();
    expect(users).toEqual(["src/client/App.svelte", "src/client/utils/sidecar-restart-toast.ts"]);
    for (const rel of users) expect(docblock).toContain(rel);
  });

  it("names every other file that still wires the event module by hand", () => {
    const handRolled = files
      .filter((rel) => rel !== HELPER_REL && read(rel).includes(EVENT_MODULE))
      .sort();
    // Not empty, or the sweep would pass by finding nothing at all.
    expect(handRolled.length).toBeGreaterThan(1);
    for (const rel of handRolled) {
      expect(
        docblock,
        `${rel} loads ${EVENT_MODULE} — name it in the docblock or migrate it to listenTauriEvent`,
      ).toContain(rel);
    }
  });

  it("does not claim to be the single implementation while copies remain", () => {
    expect(docblock).not.toMatch(/the three call sites/);
    expect(docblock).toContain("not yet the one implementation");
  });
});
