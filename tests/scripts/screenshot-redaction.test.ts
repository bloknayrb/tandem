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
  buildAccountRedaction,
  findAccountPathLeaks,
  redactHomePaths,
} from "../../scripts/screenshots/redact-account";

// `fileURLToPath(import.meta.url)` rather than `new URL(".", import.meta.url)`:
// this file runs under happy-dom (for the DOM walk below), whose global `URL`
// rejects the file: scheme Node's helper needs.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Non-null `buildAccountRedaction`, so a null regression fails loudly here. */
function redactionFor(homeDir: string): AccountRedaction {
  const redaction = buildAccountRedaction(homeDir);
  if (!redaction) throw new Error(`expected a redaction for ${homeDir}`);
  return redaction;
}

const redact = (homeDir: string, text: string) => redactHomePaths(text, redactionFor(homeDir));

describe("buildAccountRedaction", () => {
  it("declines when there is nothing to redact", () => {
    expect(buildAccountRedaction("")).toBeNull();
    expect(buildAccountRedaction("   ")).toBeNull();
    // Already generic — replacing `you` with `you` only risks false positives.
    expect(buildAccountRedaction("/home/you")).toBeNull();
    expect(buildAccountRedaction("/Users/YOU/")).toBeNull();
  });

  it("declines a home directory with no parent segment to anchor against", () => {
    // Refuses rather than guessing: an unanchored name is exactly the substring
    // match #1528 was about. The capture's leak scan then decides whether the
    // name is actually on screen, and fails the run if it is.
    expect(buildAccountRedaction("bryan")).toBeNull();
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

  it("redacts a home directory that is a top-level dir (the /root sandbox case)", () => {
    expect(redact("/root", "/root/.claude/settings.json")).toBe("/you/.claude/settings.json");
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
    expect(redact("/root", welcome)).toBe(welcome);
  });
});

describe("findAccountPathLeaks — the fail-closed backstop", () => {
  it("finds an unredacted path", () => {
    expect(findAccountPathLeaks("open /home/bryan/.claude.json now", "bryan")).toEqual([
      "/home/bryan/.claude.json",
    ]);
  });

  it("finds the account name repeated deeper in an already-redacted path", () => {
    // The narrowed replacement rewrites the home segment only; a second
    // occurrence further down would survive it. This is what turns that into a
    // red capture instead of a published leak.
    expect(findAccountPathLeaks("/home/you/.bryan/settings.json", "bryan")).toEqual([
      "/home/you/.bryan/settings.json",
    ]);
  });

  it("finds a path outside the home directory entirely", () => {
    expect(findAccountPathLeaks("C:\\Backups\\bryan\\claude.json", "bryan")).toEqual([
      "C:\\Backups\\bryan\\claude.json",
    ]);
  });

  it("ignores prose that merely uses the word", () => {
    // The old assertion (`not.toContainText(account)`) could not tell these
    // apart, which is why corrupted copy read as proof of redaction.
    expect(findAccountPathLeaks("Ask a user with admin rights to try again.", "user")).toEqual([]);
    expect(findAccountPathLeaks("Defaults to your home directory if empty.", "home")).toEqual([]);
    expect(findAccountPathLeaks("/home/you/.claude.json", "bryan")).toEqual([]);
    expect(findAccountPathLeaks("anything at all", "")).toEqual([]);
  });

  it("is case-insensitive, matching the redaction", () => {
    expect(findAccountPathLeaks("C:\\Users\\BRYAN\\config.json", "bryan")).toEqual([
      "C:\\Users\\BRYAN\\config.json",
    ]);
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
  const match = spec.match(/await page\.evaluate\(\(r\) => \{\n([\s\S]*?)\n  \}, redaction\);/);
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
      '<span class="itc-path">/root/.claude.json</span>' +
      '<span class="itc-status">EACCES on /root/.claude/settings.json (also tried /root/.claude.json)</span>';
    expect(render(html, "/root")).toBe(
      '<span class="itc-path">/you/.claude.json</span>' +
        '<span class="itc-status">EACCES on /you/.claude/settings.json (also tried /you/.claude.json)</span>',
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
    expect(spec).toContain("buildAccountRedaction(os.homedir())");
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
});
