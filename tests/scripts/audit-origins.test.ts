/**
 * The positive anchor for `scripts/audit-origins.ts` (#1482).
 *
 * WHY THIS EXISTS. After the client sites were tagged, the count of untagged
 * writes in `src/client` is zero — and zero is also exactly what an audit that
 * silently stopped scanning reports. That is the `an-empty-filter-result-
 * satisfies-a-zero-check` shape, and this repo has shipped it twice. So the
 * audit counts correctly-tagged sites too, and these tests pin the census:
 * re-narrowing the walk back to `src/server`, or adding a skip broad enough to
 * drop the client, fails here rather than printing `clean`.
 *
 * The script itself stays warn-only (it always exits 0, by design). THIS TEST
 * is the gate — so describe the enforcement as the test, never as the script.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runAudit } from "../../scripts/audit-origins";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");

const scratch: string[] = [];
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-origins-"));
  scratch.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf-8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("audit-origins census", () => {
  const result = runAudit(SRC);

  it("scans a non-trivial number of files", () => {
    // Guards the abort branch in `main()` from the other side: if the walk
    // returns nothing, every downstream count is a zero-of-zero.
    expect(result.filesScanned.length).toBeGreaterThan(100);
  });

  it("reaches src/client, which it did not before #1482", () => {
    const client = result.filesScanned.filter((f) => f.startsWith("src/client/"));
    expect(client.length).toBeGreaterThan(50);
  });

  it("counts at least five tagged sites in src/client", () => {
    // Twelve were tagged in #1482. The floor is deliberately well under that:
    // this pins that the client is being SCANNED and its helpers RECOGNISED,
    // not the exact inventory, which would churn on every new call site.
    const clientTagged = result.taggedSites.filter((s) => s.file.startsWith("src/client/"));
    expect(clientTagged.length).toBeGreaterThanOrEqual(5);
  });

  it("recognises a helper call inside a .svelte file", () => {
    // Asserted on taggedSites rather than merely on filesScanned. A `.svelte`
    // file yields hundreds of parse diagnostics from `ts.createSourceFile` and
    // still recovers its call expressions — "the file was visited" would pass
    // even if that recovery broke, and the recovery is the part that matters.
    const svelte = result.taggedSites.filter((s) => s.file.endsWith(".svelte"));
    expect(svelte.length).toBeGreaterThanOrEqual(1);
  });

  it("reports no untagged or unverified transactions in src", () => {
    expect(result.findings).toEqual([]);
  });
});

describe("audit-origins still detects what it is looking for", () => {
  // The census above proves the walk is wide. These prove it is not blind —
  // together they are what stops "clean" from being vacuous.

  it("flags a raw transact with no origin", () => {
    const dir = fixtureDir({
      "bad.ts": "export function f(doc: any) {\n  doc.transact(() => {});\n}\n",
    });
    expect(runAudit(dir).findings).toEqual([
      { kind: "untagged", file: expect.any(String), line: 2 },
    ]);
  });

  it("flags a transact tagged with an unknown identifier as needing verification", () => {
    const dir = fixtureDir({
      "odd.ts":
        "export function f(doc: any, thing: string) {\n  doc.transact(() => {}, thing);\n}\n",
    });
    const findings = runAudit(dir).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "verify", name: "thing" });
  });

  it("accepts every wrapper helper as a tagged site, and none as a finding", () => {
    // Enumerated rather than sampled: a helper missing from `HELPER_NAMES`
    // would make real call sites invisible to the census, which is the exact
    // way this anchor could rot into a zero-of-zero without failing.
    const helpers = [
      "withMcp",
      "withFileSync",
      "withInternal",
      "withReload",
      "withModeRelease",
      "withBrowser",
    ];
    const body = helpers.map((h) => `  ${h}(doc, () => {});`).join("\n");
    const dir = fixtureDir({ "good.ts": `export function f(doc: any) {\n${body}\n}\n` });

    const result = runAudit(dir);
    expect(result.findings).toEqual([]);
    expect(result.taggedSites.map((s) => s.helper).sort()).toEqual([...helpers].sort());
  });

  it("does not flag an origin forwarded through a parameter", () => {
    // `shared/origins.ts` itself relies on this: `runTransact` passes its own
    // `origin` parameter through. Widening the walk to `src` brought that file
    // into scope for the first time.
    const dir = fixtureDir({
      "fwd.ts":
        "export function f(doc: any, origin: string) {\n  doc.transact(() => {}, origin);\n}\n",
    });
    expect(runAudit(dir).findings).toEqual([]);
  });
});
