// @vitest-environment happy-dom
/**
 * Account-name redaction for the screenshot capture (#1528).
 *
 * `capture.spec.ts` slot 13 photographs the setup wizard, which prints the real
 * resolved config path for every AI client on the capture machine. Those paths
 * are rooted at `os.homedir()`, so the capture rewrites the account segment to
 * `you` before the shutter. The first implementation replaced the bare account
 * name as a SUBSTRING of every text node under `document.body`, and its own
 * comment justified a `length < 3` guard by observing that a short name "appears
 * as a substring of ordinary words and would corrupt the surrounding copy" —
 * reasoning that does not stop at two characters. `root`, `user`, `home` and
 * `admin` clear that guard, are common default accounts (this repo's own agent
 * sandboxes run with `$HOME=/root`), and are ordinary English words the app's
 * own UI copy uses.
 *
 * Neither of slot 13's assertions could see it: they checked that the account
 * string was gone and that `you` appeared somewhere, both of which a corrupted
 * page satisfies. So the rule now lives in `scripts/screenshots/redact-account.ts`
 * where it can be tested without a browser, and this file is that test.
 *
 * Two directions, and they are not symmetric. Over-replacement corrupts an
 * image; under-replacement ships someone's username in a public repo. Tests for
 * both are below, and the leak scan is the fail-closed backstop for the second.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AccountRedaction,
  type AccountRedactionPlan,
  findAccountPathLeaks,
  planAccountRedaction,
  redactHomePaths,
} from "../../scripts/screenshots/redact-account";

// `fileURLToPath(import.meta.url)` rather than `new URL(".", import.meta.url)`:
// this file runs under happy-dom (for the DOM walk below), whose global `URL`
// rejects the file: scheme Node's helper needs.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The `redact` arm of a plan, so a downgrade to `scan-only` fails loudly here. */
function redactionFor(homeDir: string): AccountRedaction {
  const plan = planAccountRedaction(homeDir);
  if (plan.kind !== "redact")
    throw new Error(`expected a redaction for ${homeDir}, got ${plan.kind}`);
  return plan.redaction;
}

const redact = (homeDir: string, text: string) => redactHomePaths(text, redactionFor(homeDir));

/** Scan `text` the way the capture does: through the plan for `homeDir`. */
const leaksFor = (homeDir: string, text: string): string[] =>
  findAccountPathLeaks(text, planAccountRedaction(homeDir));

/**
 * A hand-built `scan-only` plan.
 *
 * The arm with no prefix mask, which is what isolates the boundary rules from
 * the masking rules — and the only way to reach the empty-account guard, since
 * the planner never produces one.
 */
const scanOnly = (account: string): AccountRedactionPlan => ({ kind: "scan-only", account });

describe("planAccountRedaction", () => {
  it("has nothing to do when the account is absent or already the placeholder", () => {
    expect(planAccountRedaction("")).toEqual({ kind: "none" });
    expect(planAccountRedaction("   ")).toEqual({ kind: "none" });
    // Already generic — replacing `you` with `you` only risks false positives,
    // and scanning for it would report every correctly redacted path.
    expect(planAccountRedaction("/home/you")).toEqual({ kind: "none" });
    expect(planAccountRedaction("/Users/YOU/")).toEqual({ kind: "none" });
  });

  it("falls back to scan-only when there is no parent segment to anchor against", () => {
    // Refuses rather than guessing: an unanchored name is exactly the substring
    // match #1528 was about. The capture's leak scan then decides whether the
    // name is actually on screen, and fails the run if it is.
    expect(planAccountRedaction("bryan")).toEqual({ kind: "scan-only", account: "bryan" });
  });

  it("falls back to scan-only for a top-level home directory (the /root sandbox)", () => {
    // `/root` has a parent of `[""]`, which is not a prefix — anchoring against
    // it degenerates to "any separator". Measured on the version that did:
    // `/etc/skel/root/profile` became `/etc/skel/you/profile`, which is #1528's
    // own bug. The scan takes over instead.
    expect(planAccountRedaction("/root")).toEqual({ kind: "scan-only", account: "root" });
    // One real segment IS a prefix, so this is not the same case: `C:\Users`
    // anchors against `C:` and redacts normally.
    expect(planAccountRedaction("C:\\Users").kind).toBe("redact");
  });

  it("trims and tolerates a trailing separator", () => {
    // Both are shapes `os.homedir()` can hand back or a config can carry, and
    // both change the parent prefix if mishandled: without the trim the leading
    // segment is `" "` rather than `""`, and without the pop the account
    // segment is the empty string after the trailing slash.
    expect(planAccountRedaction("  /home/bryan  ")).toEqual(planAccountRedaction("/home/bryan"));
    expect(planAccountRedaction("/home/bryan/")).toEqual(planAccountRedaction("/home/bryan"));
    expect(redact("  /home/bryan  ", "/home/bryan/.claude.json")).toBe("/home/you/.claude.json");
    expect(redact("/home/bryan/", "/home/bryan/.claude.json")).toBe("/home/you/.claude.json");
  });

  it("escapes regex metacharacters in the account and in the parent prefix", () => {
    // An account or a parent directory containing `.` is legal on every OS this
    // ships to, and an unescaped one turns into "any character" — matching, and
    // therefore rewriting, a DIFFERENT directory.
    expect(redact("/home/a.b", "/home/a.b/.claude.json")).toBe("/home/you/.claude.json");
    expect(redact("/home/a.b", "/home/axb/.claude.json")).toBe("/home/axb/.claude.json");
    expect(redact("/ho.me/bryan", "/ho.me/bryan/x")).toBe("/ho.me/you/x");
    expect(redact("/ho.me/bryan", "/hoxme/bryan/x")).toBe("/hoxme/bryan/x");
  });

  it("matches a doubled separator, which is what a rendered path can carry", () => {
    // `SEP` is `[\\/]+`, not `[\\/]`. A path joined by a stack that already had a
    // trailing slash renders `C:\\Users\\\\bryan\\...`, and a single-separator
    // pattern would ship it.
    expect(redact("C:\\Users\\bryan", "C:\\Users\\\\bryan\\config.json")).toBe(
      "C:\\Users\\\\you\\config.json",
    );
    expect(redact("/home/bryan", "//home//bryan//notes.md")).toBe("//home//you//notes.md");
  });

  it("keeps two-letter accounts — the old length guard is gone", () => {
    // The guard existed only to stop substring corruption. Segment anchoring
    // stops that at every length, so a short name is now redacted rather than
    // shipped.
    expect(redact("/home/ab", "/home/ab/.claude.json")).toBe("/home/you/.claude.json");
    expect(redact("/home/ab", "grab a stable build")).toBe("grab a stable build");
  });
});

describe("redactHomePaths — the account segment of a rendered path", () => {
  it("redacts a posix config path", () => {
    expect(redact("/home/bryan", "/home/bryan/.claude.json")).toBe("/home/you/.claude.json");
  });

  it("redacts macOS Application Support paths", () => {
    expect(
      redact("/Users/bryan", "/Users/bryan/Library/Application Support/Claude/config.json"),
    ).toBe("/Users/you/Library/Application Support/Claude/config.json");
  });

  it("redacts Windows paths whichever separator the UI rendered", () => {
    const home = "C:\\Users\\bryan";
    expect(redact(home, "C:\\Users\\bryan\\AppData\\Roaming\\Claude\\config.json")).toBe(
      "C:\\Users\\you\\AppData\\Roaming\\Claude\\config.json",
    );
    // Same machine, path normalized to forward slashes somewhere in the stack.
    expect(redact(home, "C:/Users/bryan/AppData/Roaming/Claude/config.json")).toBe(
      "C:/Users/you/AppData/Roaming/Claude/config.json",
    );
    // Windows paths are case-insensitive; the rendered case must not decide.
    expect(redact(home, "c:\\users\\Bryan\\AppData")).toBe("c:\\users\\you\\AppData");
  });

  it("redacts every occurrence in one run of text, and the bare home directory", () => {
    expect(
      redact(
        "/home/bryan",
        "EACCES: permission denied, open '/home/bryan/.claude.json' (tried /home/bryan/.config too)",
      ),
    ).toBe(
      "EACCES: permission denied, open '/home/you/.claude.json' (tried /home/you/.config too)",
    );
    // Sentence-final punctuation must not hide a leak.
    expect(redact("/home/bryan", "Claude launches in /home/bryan.")).toBe(
      "Claude launches in /home/you.",
    );
  });

  it("leaves paths that merely start with the account name alone", () => {
    expect(redact("/home/user", "/home/username/notes.md")).toBe("/home/username/notes.md");
    expect(redact("/home/root", "/home/root-backup/settings.json")).toBe(
      "/home/root-backup/settings.json",
    );
    // `_` is a name character in SEGMENT_END, and the docstring says so. It was
    // claimed in prose and pinned by nothing: dropping it from the class turned
    // a sibling directory into a redaction.
    expect(redact("/home/bryan", "/home/bryan_old/notes.md")).toBe("/home/bryan_old/notes.md");
  });

  it("leaves a URL path segment that only starts with the account name alone", () => {
    // The wizard links claude.com/claude-code; a machine whose account is
    // `claude` must not turn that into `claude.com/you-code`.
    expect(redact("/home/claude", "Reinstall from claude.com/claude-code to fix it")).toBe(
      "Reinstall from claude.com/claude-code to fix it",
    );
  });
});

/**
 * The decisive case: UI copy that contains the account name as an ordinary
 * English word, in the same DOM the walk covers, on a machine whose account is
 * that word. The pre-#1528 implementation rewrote all of it. Each sample is
 * pinned against the component that renders it below, so this cannot drift into
 * testing prose the app no longer has.
 */
const COPY_SAMPLES: ReadonlyArray<{
  account: string;
  copy: string;
  source: string;
}> = [
  {
    account: "home",
    copy: "Folder where Claude launches. Defaults to your home directory if empty.",
    source: "src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte",
  },
  {
    account: "home",
    copy: "Working directory must be a folder inside your home directory.",
    source: "src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte",
  },
  {
    account: "admin",
    copy: "This adds a Windows firewall rule so the Cowork VM can connect back — admin is required once.",
    source: "src/client/components/IntegrationWizardModal.svelte",
  },
  {
    account: "admin",
    copy: "Cowork integration needs Windows admin permission to add the firewall rule that lets",
    source: "src/client/components/CoworkAdminDeclinedModal.svelte",
  },
];

describe("redactHomePaths — ordinary UI copy is not collateral", () => {
  it.each(COPY_SAMPLES)("the app really renders this copy: $copy", ({ copy, source }) => {
    // Without this pin the cases below could keep passing against copy that no
    // longer exists — a test proving nothing about the real capture surface.
    expect(collapse(read(source))).toContain(collapse(copy));
  });

  it.each(COPY_SAMPLES)("leaves it byte-identical when the account is $account", ({
    account,
    copy,
  }) => {
    expect(redact(`/home/${account}`, copy)).toBe(copy);
  });

  it("redacts the path and leaves the prose, in the same text run", () => {
    // One text node, both halves: this is what `.itc-status` looks like when the
    // loopback (unscrubbed) readFile error lands next to the wizard's own copy.
    const text =
      "Couldn't check this one — EACCES, open '/home/user/.claude.json'. Ask a user with admin rights.";
    expect(redact("/home/user", text)).toBe(
      "Couldn't check this one — EACCES, open '/home/you/.claude.json'. Ask a user with admin rights.",
    );
  });

  it("leaves the sample document's own prose alone under a `user` account", () => {
    // `sample/welcome.md` is what the editor renders behind the wizard, and it
    // is in `document.body`, so the walk reaches it.
    const welcome = read("sample/welcome.md");
    expect(welcome).toMatch(/user/i);
    expect(redact("/home/user", welcome)).toBe(welcome);
    expect(redact("/home/root", welcome)).toBe(welcome);
  });
});

describe("findAccountPathLeaks — the fail-closed backstop", () => {
  it("finds an unredacted path", () => {
    expect(leaksFor("/home/bryan", "open /home/bryan/.claude.json now")).toEqual([
      "/home/bryan/.claude.json",
    ]);
  });

  it("finds the account name repeated deeper in an already-redacted path", () => {
    // The narrowed replacement rewrites the home segment only; a second
    // occurrence further down would survive it. This is what turns that into a
    // red capture instead of a published leak.
    expect(leaksFor("/home/bryan", "/home/you/.bryan/settings.json")).toEqual([
      "/home/you/.bryan/settings.json",
    ]);
  });

  it("finds a path outside the home directory entirely", () => {
    expect(leaksFor("C:\\Users\\bryan", "C:\\Backups\\bryan\\claude.json")).toEqual([
      "C:\\Backups\\bryan\\claude.json",
    ]);
  });

  it("scans on behalf of a home directory it could not anchor", () => {
    // The `scan-only` arm is the whole reason refusing to redact is safe. There
    // is no prefix to mask, so every bounded run reports.
    expect(leaksFor("/root", "/root/.claude/settings.json")).toEqual([
      "/root/.claude/settings.json",
    ]);
    expect(leaksFor("bryan", "/home/bryan/.claude.json")).toEqual(["/home/bryan/.claude.json"]);
    // ...and prose still is not path-shaped, so the boundary rules still apply.
    expect(leaksFor("/root", "Reset it from the root of the project.")).toEqual([]);
  });

  it("does not scan at all when the account is already the placeholder", () => {
    // MEASURED FAILURE of scanning unconditionally: on `$HOME=/home/you` the
    // page is correct by definition and every path on it reported as a leak, so
    // slot 13 could never be captured.
    expect(leaksFor("/home/you", "/home/you/.claude.json")).toEqual([]);
    expect(leaksFor("", "/home/anyone/.claude.json")).toEqual([]);
  });

  it("ignores prose that merely uses the word", () => {
    // The old assertion (`not.toContainText(account)`) could not tell these
    // apart, which is why corrupted copy read as proof of redaction.
    expect(leaksFor("/home/user", "Ask a user with admin rights to try again.")).toEqual([]);
    expect(leaksFor("/srv/home", "Defaults to your home directory if empty.")).toEqual([]);
    expect(leaksFor("/home/bryan", "/home/you/.claude.json")).toEqual([]);
    // A hand-built plan is the only way to reach an empty account — the planner
    // returns `none` for one — and without the guard the bounded pattern is two
    // lookarounds around nothing, which matches at every boundary.
    expect(findAccountPathLeaks("/home/bryan/x", { kind: "scan-only", account: "" })).toEqual([]);
  });

  it("is case-insensitive, matching the redaction", () => {
    expect(leaksFor("C:\\Users\\bryan", "C:\\Users\\BRYAN\\config.json")).toEqual([
      "C:\\Users\\BRYAN\\config.json",
    ]);
  });

  it("does not report the redaction's OWN OUTPUT when the account is in the prefix", () => {
    // MEASURED FAILURE before the prefix mask: `findAccountPathLeaks(
    // "/home/you/.claude.json", "home")` returned that token. On `$HOME=/home/home`
    // the redaction is byte-perfect and slot 13 failed forever. This is a class,
    // not a case — `users` is the Windows twin, and both are among the default
    // accounts this module exists for.
    expect(leaksFor("/home/home", "/home/you/.claude.json")).toEqual([]);
    expect(leaksFor("C:\\Users\\users", "C:\\Users\\you\\AppData\\Roaming\\Claude")).toEqual([]);
    // The mask is the redaction's output — prefix AND placeholder — not the
    // prefix alone, so it cannot swallow a real leak that happens to sit under
    // a same-named directory somewhere else.
    expect(leaksFor("/home/home", "/backup/home/config.json")).toEqual([
      "/backup/home/config.json",
    ]);
    expect(leaksFor("/home/home", "/home/home/.claude.json")).toEqual(["/home/home/.claude.json"]);
    // And a second, genuine occurrence below the masked prefix still reports.
    expect(leaksFor("/home/home", "/home/you/home/notes.md")).toEqual(["/home/you/home/notes.md"]);
  });

  it("does not report a name that is only a SUBSTRING of a path segment", () => {
    // Through the `scan-only` arm on purpose: it carries no prefix mask, so
    // these isolate the BOUNDARY. Routed through a `redact` plan instead, the
    // first two would pass because the mask ate the token, and a regression in
    // `NAME_CHAR` would go unnoticed.
    //
    // The scan must agree with the redaction's boundary, or it fails captures
    // that were redacted perfectly. All three of these were measured failing
    // against a plain `includes`, and all three are accounts #1528 is about.
    //
    // `user` on Windows: the redaction correctly produced `C:\Users\you\...`,
    // and `includes("user")` then matched inside `Users`.
    expect(findAccountPathLeaks("C:\\Users\\you\\.claude.json", scanOnly("user"))).toEqual([]);
    // `us` — reachable only because the length guard is gone.
    expect(findAccountPathLeaks("C:\\Users\\you\\.claude.json", scanOnly("us"))).toEqual([]);
    // `claude`: `/claude-code` is the shape redact-account.ts's own docstring
    // promises stays intact, so reporting it as a leak contradicts the module.
    // `-` is a name character in SEGMENT_END, and must be one here too.
    expect(findAccountPathLeaks("see claude.com/claude-code for docs", scanOnly("claude"))).toEqual(
      [],
    );
    // `_` is the other half of that class, claimed in the module's prose and
    // pinned by nothing until now.
    expect(findAccountPathLeaks("/home/you/bryan_old/notes.md", scanOnly("bryan"))).toEqual([]);
    // The LEADING boundary, which the cases above do not exercise: they are all
    // prefix collisions, and a trailing-only guard passes every one of them. A
    // name that is the SUFFIX of a longer segment needs the other half.
    expect(findAccountPathLeaks("/var/www/webroot/index.html", scanOnly("root"))).toEqual([]);
    expect(findAccountPathLeaks("/opt/sysadmin/config.json", scanOnly("admin"))).toEqual([]);
  });

  it("escapes regex metacharacters in the account it scans for", () => {
    // Unescaped, `a.b` matches `axb` and reports a path carrying no part of the
    // account name — a capture that can never go green.
    expect(findAccountPathLeaks("/home/axb/.claude.json", scanOnly("a.b"))).toEqual([]);
    expect(findAccountPathLeaks("/home/a.b/.claude.json", scanOnly("a.b"))).toEqual([
      "/home/a.b/.claude.json",
    ]);
  });

  it("still reports a bounded run, so the backstop is not weakened", () => {
    // The boundary must not become an excuse to miss the real thing: each of
    // these is the account as its own run inside a path, and each must report.
    expect(findAccountPathLeaks("C:\\Users\\user\\.claude.json", scanOnly("user"))).toEqual([
      "C:\\Users\\user\\.claude.json",
    ]);
    expect(findAccountPathLeaks("/home/you/.us/settings.json", scanOnly("us"))).toEqual([
      "/home/you/.us/settings.json",
    ]);
    expect(findAccountPathLeaks("/home/claude/.claude.json", scanOnly("claude"))).toEqual([
      "/home/claude/.claude.json",
    ]);
  });

  it("leaves a CLASS of ambiguities failing on purpose, and says so", () => {
    // Masking the prefix cannot help when the account collides with a segment
    // BELOW the home directory: nothing distinguishes that from a real second
    // occurrence. Slot 13's own paths are what collide — `.claude.json`, and
    // `C:\Users\you\AppData\Roaming\Claude\claude_desktop_config.json` — so the
    // class is `claude`, `json`, `appdata`, `roaming`, `config`, not the single
    // `claude` case this once claimed. Stopping the capture is the correct side
    // to err on, but it needs a human, not a code change. Pinned so the choice
    // stays deliberate rather than incidental.
    expect(leaksFor("/home/claude", "/home/you/.claude.json")).toEqual(["/home/you/.claude.json"]);
    expect(leaksFor("/home/json", "/home/you/.claude.json")).toEqual(["/home/you/.claude.json"]);
    expect(
      leaksFor("C:\\Users\\appdata", "C:\\Users\\you\\AppData\\Roaming\\Claude\\config.json"),
    ).toEqual(["C:\\Users\\you\\AppData\\Roaming\\Claude\\config.json"]);
  });
});

/**
 * The browser half, executed for real.
 *
 * The DOM walk lives inside a `page.evaluate` callback, which Playwright
 * serializes to source — it cannot import anything, so it cannot be exercised by
 * importing it either. Rather than test a copy of it (which would pass while the
 * real one rotted), this lifts the callback body verbatim out of `capture.spec.ts`
 * and runs it against a happy-dom document. Extraction failing throws; it cannot
 * skip quietly.
 */
describe("the capture spec's DOM walk, run against a real document", () => {
  const spec = read("scripts/screenshots/capture.spec.ts");
  const match = spec.match(
    /await page\.evaluate\(\(r\) => \{\n([\s\S]*?)\n  \}, plan\.redaction\);/,
  );
  if (!match) {
    throw new Error(
      "Could not lift the page.evaluate callback out of capture.spec.ts — if the " +
        "redaction moved, move this extraction with it rather than deleting it.",
    );
  }
  const walk = new Function("r", match[1]) as (r: AccountRedaction) => void;

  const render = (html: string, homeDir: string): string => {
    document.body.innerHTML = html;
    walk(redactionFor(homeDir));
    return document.body.innerHTML;
  };

  it("rewrites the account segment of a path text node", () => {
    // `.itc-path` is what `IntegrationTargetCard.svelte` renders the resolved
    // config path into, and what slot 13's surviving assertion targets.
    expect(render('<span class="itc-path">/home/bryan/.claude.json</span>', "/home/bryan")).toBe(
      '<span class="itc-path">/home/you/.claude.json</span>',
    );
  });

  it("leaves copy that merely uses the account word untouched, in the same DOM", () => {
    // The #1528 case end to end: a machine whose account is `home`, a page with
    // both a path node and a prose node. The pre-fix walk rewrote both.
    const html =
      '<span class="itc-path">/home/home/.claude.json</span>' +
      "<p>Folder where Claude launches. Defaults to your home directory if empty.</p>";
    expect(render(html, "/home/home")).toBe(
      '<span class="itc-path">/home/you/.claude.json</span>' +
        "<p>Folder where Claude launches. Defaults to your home directory if empty.</p>",
    );
  });

  it("rewrites every path node on the page, and every path within a node", () => {
    // The walk is body-wide by design: on loopback the wizard's unscrubbed
    // `errorMessage` reaches `.itc-status` with a path in it too. The second
    // node carries two paths, so a walk that dropped the regex's `g` flag would
    // ship the second one.
    const html =
      '<span class="itc-path">/home/root/.claude.json</span>' +
      '<span class="itc-status">EACCES on /home/root/.claude/settings.json (also tried /home/root/.claude.json)</span>';
    expect(render(html, "/home/root")).toBe(
      '<span class="itc-path">/home/you/.claude.json</span>' +
        '<span class="itc-status">EACCES on /home/you/.claude/settings.json (also tried /home/you/.claude.json)</span>',
    );
  });

  it("does not disturb attributes or element structure", () => {
    // Only text nodes are touched. The card's testid slug is built from the
    // config path, so it still carries the account name — it is not rendered,
    // and rewriting attributes would risk breaking selectors mid-capture.
    const html = '<label data-testid="integration-wizard-card-home-bryan-claude-json">x</label>';
    expect(render(html, "/home/bryan")).toBe(html);
  });

  it("leaves the page alone when there is nothing anchored to replace", () => {
    const html = "<p>Ready to connect (settings file will be created)</p>";
    expect(render(html, "/home/user")).toBe(html);
  });
});

/**
 * Source guards. The browser half of the redaction lives inside a
 * `page.evaluate` callback — Playwright serializes it to source, so it cannot
 * import this module and the walk cannot be exercised here. These pin the two
 * things that would silently undo the fix: the spec reverting to a substring
 * replace, and the assertions reverting to ones a corrupted page satisfies.
 */
describe("capture.spec.ts wiring", () => {
  const spec = read("scripts/screenshots/capture.spec.ts");

  it("builds its redaction from the shared module", () => {
    expect(spec).toContain('from "./redact-account"');
    expect(spec).toContain("planAccountRedaction(os.homedir())");
  });

  it("applies the module's pattern, flags and replacement verbatim in the browser", () => {
    expect(spec).toContain("new RegExp(r.pattern, r.flags)");
    expect(spec).toContain("replace(re, r.replacement)");
  });

  it("no longer replaces the bare account name as a substring", () => {
    // The pre-#1528 body: `node.nodeValue.split(name).join("you")`. Written
    // wide enough to also catch the same split against the module's own
    // `r.account` field, which is the shape a partial revert would take.
    expect(spec).not.toMatch(/\.split\([^)]*\b(name|account)\b[^)]*\)/);
  });

  it("asserts on path-shaped leaks rather than on the bare account string", () => {
    expect(spec).toContain("findAccountPathLeaks(");
    expect(spec).not.toContain("not.toContainText(account");
  });

  it("scans with the plan, not a re-derived account name", () => {
    // Re-deriving the bare account name from the home directory's basename
    // throws away the two things the scan needs to be correct: the parent
    // prefix (so it does not report its own output on a `/home/home` machine)
    // and the `none` outcome (so it does not scan for `you` on a machine
    // already named that). Both were measured failing.
    //
    // The negative below is spelled out rather than described for a reason —
    // it matches this file too, so keep the expression out of the prose.
    expect(spec).toContain('findAccountPathLeaks(await page.locator("body").innerText(), plan)');
    expect(spec).not.toMatch(/path\.basename\(os\.homedir\(\)\)/);
  });
});
