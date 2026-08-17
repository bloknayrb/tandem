import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every hand-rolled UNC / device-namespace prefix test in `src/`, and why it is
 * allowed to exist outside `src/shared/windows-path-safety.ts`.
 *
 * **An entry here is a claim, not a mute button.** #1417 happened because four
 * copies of this rule drifted apart and each one's gap was different — the
 * `supervisor.ts` copy missed bare `//`, the `docx-export.ts` copies missed both
 * forward-slash forms. Adding a file to this list without a reason that
 * survives being read out loud re-creates exactly that.
 */
const ALLOWED = new Map<string, string>([
  [
    "src/shared/windows-path-safety.ts",
    "The canonical definition. This is the file everything else should delegate to.",
  ],
  [
    "src/cli/win-path-guard.ts",
    "Deliberate second variant: permits `\\\\?\\C:\\…` (extended-length LOCAL) and rejects " +
      "every other `\\\\`-rooted form, because containment under %LOCALAPPDATA% confines the " +
      "one it admits and Tauri's path APIs hand back that prefix. Sharing the stricter shared " +
      "predicate would reject legitimate local paths. `windows-path-safety.ts`'s own docblock " +
      "names this as intentional — do not 'fix' it. Written as an ALLOWLIST of that one shape " +
      "rather than an enumeration of " +
      "bad forms: the enumeration it replaced let `\\\\?\\unc\\…` and `\\\\?\\GLOBALROOT\\…` " +
      "through, because it treated the whole `\\\\?\\` namespace as fine once a literal-cased " +
      "`UNC\\` did not follow.",
  ],
  [
    "src/client/editor/utils/url-safety.ts",
    "Not a UNC check at all: `//host/x` is a protocol-relative URL, rejected because it is an " +
      "EXTERNAL navigation rather than a document-relative path. Same spelling, different domain.",
  ],
  [
    "src/shared/image-src-safety.ts",
    "Not a UNC check at all: `//host/img.png` is a protocol-relative image src, rejected as an " +
      "EXTERNAL fetch rather than a document-relative path — the image-src sibling of the " +
      "`url-safety.ts` entry above. It is a separate file rather than a duplicate of that check " +
      "because file-import (`mdast-ydoc.ts`, `docx-html.ts`) needs the identical guard " +
      "server-side; `sanitizeImageSrcForPaste` now re-exports this module's `sanitizeImageSrc` " +
      "instead of carrying its own copy (#1420).",
  ],
  [
    "src/server/file-io/docx-export.ts",
    "Redundant pre-filter inside a URL validator that already refuses every non-http(s)/mailto " +
      "scheme four lines later, so the `\\\\` test cannot be the only thing standing between a " +
      "hostile input and a syscall — it performs none. Left alone deliberately: converting it " +
      "would imply it was load-bearing.",
  ],
  ["src/server/file-io/spike-docx-export.ts", "Spike twin of the above, and not shipped."],
  [
    "src-tauri/src/cowork_workspace_scan.rs",
    "Rust cannot import the TypeScript definition, so the §3 guard's twin is a genuine " +
      "second implementation. Permits `\\\\?\\C:\\…` for the same reason win-path-guard.ts " +
      "does — containment under the canonical root confines it — and is written as the same " +
      "allowlist for the same reason. Kept in step by hand; the two files cross-reference " +
      "each other.",
  ],
]);

/**
 * `src-tauri/src/lib.rs` is NOT in that map, and its absence is a finding
 * rather than an oversight.
 *
 * `is_unc_or_network_path` there is a real third definition — stricter than the
 * scan module's (it rejects `\\?\C:\…` too, because neither
 * `validate_open_candidate` nor `show_in_file_manager` has a containment check
 * to lean on). It used to appear in the map because it was written as
 * `starts_with(r"\\")`. Rewriting it to match either separator turned it into a
 * `matches!` over two chars, and the detector below — which matches a
 * *spelling* — stopped seeing it.
 *
 * So it left the allowlist not because the copy went away but because the copy
 * became invisible, which is the exact blind spot the detector's own docblock
 * warns about. Listing it here would fail the staleness check next door; the
 * honest record is this comment plus the pointer in
 * `src/shared/windows-path-safety.ts`.
 */

/**
 * A `startsWith` against a literal UNC / device-namespace prefix, in TS or Rust
 * (`"\\\\…"`, `"//…"`, or Rust's raw `r"\\…"`).
 *
 * **This is a spelling check, not a semantic one, and the difference is worth
 * stating plainly.** A copy written as `/^\\\\/.test(p)`, `p.slice(0, 2) === …`,
 * or with the prefix hoisted into a named constant walks straight past. It
 * catches the shape all four #1417 copies actually took, which is what makes it
 * worth having — not a proof that no fifth copy exists.
 */
const RAW_PREFIX = /\.starts_?[wW]ith\(\s*r?"(?:\\\\|\/\/)/;

function walkSource(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|svelte|rs)$/.test(e.name) && !e.name.endsWith(".d.ts"))
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).replace(/\\/g, "/"));
}

/**
 * Invariant §3 (#1417). A UNC prefix test is worth one definition, because the
 * failure mode of a second copy is silent: it type-checks, it passes tests, and
 * it is missing one separator flavour that an attacker supplies.
 *
 * **This catches duplication and never ordering.** The other half of #1417 was
 * guards that ran the check *after* a `stat`/`realpath`/`canonicalize` had
 * already performed the SMB handshake, and no static walk over string literals
 * can see that. Ordering is pinned per-site by the tests next to each guard.
 */
describe("UNC prefix checks are not duplicated (#1417, invariant §3)", () => {
  it("has no hand-rolled prefix test outside the allowlist", () => {
    // Covers the Rust half too: `src-tauri/` holds two of the copies this
    // invariant is about, and walking `src/` alone left them invisible to it.
    const offenders = [...walkSource("src"), ...walkSource("src-tauri/src")]
      .filter((file) => {
        const body = readFileSync(path.join(ROOT, file), "utf8");
        return body.split("\n").some((line) => RAW_PREFIX.test(line));
      })
      .filter((file) => !ALLOWED.has(file));

    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still contains a prefix test", () => {
    // A stale entry is worse than none: it reads as a reviewed exemption for a
    // file that no longer has the thing being exempted, and it hides the next
    // real one that lands there.
    const stale = [...ALLOWED.keys()].filter((file) => {
      const body = readFileSync(path.join(ROOT, file), "utf8");
      return !body.split("\n").some((line) => RAW_PREFIX.test(line));
    });

    expect(stale).toEqual([]);
  });

  it("the sites converted by #1417 actually CALL the shared guard", () => {
    // Deliberately not `toContain("rejectUnsafeWindowsPrefix")` — the import
    // line alone satisfies that, so the assertion would stay green after the
    // last real call site was deleted. Match an invocation instead.
    //
    // Behaviour is pinned properly next door (`tests/server/unc-guard-ordering`
    // and `supervisor.test.ts` assert the syscall never happens); this only
    // guards against the delegation being quietly unwound back into a local
    // copy, which is the drift that produced #1417 in the first place.
    for (const file of [
      "src/server/launcher/supervisor.ts",
      "src/server/session/manager.ts",
      "src/server/integrations/apply.ts",
      "src/server/integrations/node-binary.ts",
    ]) {
      const body = readFileSync(path.join(ROOT, file), "utf8");
      expect(body, `${file} should CALL the shared guard`).toMatch(/rejectUnsafeWindowsPrefix\(/);
    }
  });
});
