import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrub } from "../../src/server/sentry.js";

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

  it("leaves benign strings untouched", () => {
    expect(scrub("ordinary error: connection reset")).toBe("ordinary error: connection reset");
  });
});
