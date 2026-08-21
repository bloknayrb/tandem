import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrub } from "../../src/server/sentry.js";
import { redactPaths } from "../../src/shared/scrub-text.js";

/**
 * The scrubber is the privacy-load-bearing surface of #921. These tests lock in
 * that home-dir paths and obvious secrets are redacted before any event leaves
 * the sidecar. `scrub` reads `$HOME`/`$USERPROFILE`, so the env is pinned.
 */
describe("server sentry scrub", () => {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    process.env.HOME = "/home/alice";
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it("redacts the $HOME prefix to ~", () => {
    expect(scrub("ENOENT: /home/alice/docs/secret.md")).toBe("ENOENT: ~/docs/secret.md");
  });

  it("redacts other users' /home segments (regex, not the $HOME swap)", () => {
    // HOME is /home/alice here, so /home/bob is not the literal-swap target;
    // the /home/<user> regex collapses the user segment to [user].
    expect(scrub("/home/bob/notes.md missing")).toBe("/home/[user]/notes.md missing");
  });

  it("redacts /Users segments (macOS)", () => {
    delete process.env.HOME;
    expect(scrub("at /Users/carol/Library/x")).toBe("at /Users/[user]/Library/x");
  });

  it("redacts Windows user profiles", () => {
    delete process.env.HOME;
    expect(scrub(String.raw`C:\Users\dave\AppData\Tandem`)).toBe(
      String.raw`C:\Users\[user]\AppData\Tandem`,
    );
  });

  it("redacts Anthropic-style API keys", () => {
    expect(scrub("auth failed with sk-ant-api03-abcdEFGH1234_zz")).toBe(
      "auth failed with sk-ant-[redacted]",
    );
  });

  it("redacts bearer tokens", () => {
    expect(scrub("Authorization: Bearer abcdef0123456789ghij")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("redacts the wider credential set the sidecar can actually hold (#1439)", () => {
    // The sidecar is the half most likely to be holding one of these: MCP
    // server configs carry `env`/`headers` full of API keys — `GET
    // /api/integrations/existing` exists precisely because of that — so an
    // error quoting one used to reach Sentry unredacted. It shares
    // `shared/scrub-text.ts` with the WebView reporter now; before that it had
    // a private copy carrying only the three patterns above, which made the
    // most exposed of the three surfaces the least redacted.
    delete process.env.HOME;
    expect(scrub("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe("token ghp_[redacted]");
    expect(scrub("github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789")).toBe(
      "github_pat_[redacted]",
    );
    expect(scrub("Authorization: Basic YWxpY2U6aHVudGVyMg==")).toBe(
      "Authorization: Basic [redacted]",
    );
    expect(
      scrub(
        "failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("failed: [redacted-jwt]");
    expect(scrub("GET /api/events?token=abc123def&x=1 failed")).toBe(
      "GET /api/events?token=[redacted]&x=1 failed",
    );
    expect(scrub("connect https://alice:hunter2@internal.example.com/doc")).toBe(
      "connect https://[redacted]@internal.example.com/doc",
    );
  });

  it("agrees with the shared path scrubber on Windows case (#1439)", () => {
    // The server half kept its own copy of the three path regexes and drifted:
    // the shared one was fixed to be case-insensitive on `\Users\` (Windows
    // paths are), this one was not, so a lowercase path leaked the OS account
    // name from the sidecar into a public issue. `redactHome` composes the
    // shared pass now, and this pins the two together — a second copy is how
    // one of them gets fixed and the other does not.
    delete process.env.HOME;
    for (const input of [
      String.raw`c:\users\bob\notes.md`,
      String.raw`C:\Users\bob\notes.md`,
      String.raw`C:\USERS\bob\notes.md`,
      "/Users/bob/notes.md",
      "/home/bob/notes.md",
    ]) {
      expect(scrub(input)).toBe(redactPaths(input));
      expect(scrub(input)).not.toContain("bob");
    }
  });

  it("leaves benign strings untouched", () => {
    expect(scrub("ordinary error: connection reset")).toBe("ordinary error: connection reset");
  });
});
