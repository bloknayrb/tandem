/**
 * The Hocuspocus lifecycle must be installed before every bind (ADR-033).
 *
 * A doc that loads before installation gets no server-side observers for its
 * lifetime — annotations, replies, awareness and dirty tracking all silently
 * absent — and a connection that authenticates before installation is rejected
 * with the same log line as a legitimate stale-tab rejection. Neither produces
 * a type error or a failing test of its own.
 *
 * Two layers, because each catches what the other cannot:
 *
 *   1. **Source order over every bind site**, derived rather than enumerated.
 *      `index.ts`'s `main()` cannot be imported without stubbing ~20 transitive
 *      imports, so ordering inside it is only checkable as text — but the set of
 *      bind sites is derived from the source, so a THIRD transport added later
 *      is covered without anyone remembering to extend this file. The stdio
 *      branch has no runtime coverage anywhere in the suite; this is what it has.
 *   2. **Runtime consequence**, in `stale-tab-resync.test.ts`: with the
 *      lifecycle uninstalled, a real client over a real socket presenting the
 *      CORRECT token is still refused. That is what this ordering is protecting
 *      against, and it lives next to the harness that can already bind.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const INDEX_TS = join(import.meta.dirname, "..", "..", "src", "server", "index.ts");

describe("installation precedes every Hocuspocus bind", () => {
  it("installs before every startHocuspocus call site in index.ts", () => {
    const src = readFileSync(INDEX_TS, "utf8");

    const installIdx = src.indexOf("installTandemLifecycle()");
    expect(installIdx, "index.ts must install the lifecycle").toBeGreaterThan(-1);
    expect(
      src.indexOf("installTandemLifecycle()", installIdx + 1),
      "exactly one install site — two would mean two mechanisms again",
    ).toBe(-1);

    const bindSites = [...src.matchAll(/startHocuspocus\(/g)].map((m) => m.index as number);

    // Control. The assertion below is a "every element of X satisfies P" check,
    // which an empty X passes silently — and a rename of `startHocuspocus`
    // would empty it. Both transports must be present: HTTP and stdio.
    expect(bindSites.length, "expected a bind site per transport").toBeGreaterThanOrEqual(2);
    expect(src, "the stdio transport branch must still exist").toContain("TANDEM_TRANSPORT");

    for (const site of bindSites) {
      const line = src.slice(src.lastIndexOf("\n", site) + 1, src.indexOf("\n", site));
      expect(
        installIdx,
        `installTandemLifecycle() must precede this bind: ${line.trim()}`,
      ).toBeLessThan(site);
    }
  });
});
