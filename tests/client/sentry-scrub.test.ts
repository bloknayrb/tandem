import { describe, expect, it } from "vitest";
import { __test } from "../../src/client/sentry";

/**
 * Client-side scrubbing for #921. `sentry.ts` only `import type`s
 * `@sentry/browser` at module top (the real SDK is dynamically imported inside
 * `initCrashReporting`), so this test loads without the optional dep installed.
 */
describe("client sentry scrub", () => {
  const { scrub, redactSecrets, redactPaths } = __test;

  it("redacts macOS user paths", () => {
    expect(redactPaths("/Users/alice/Documents/x.md")).toBe("/Users/[user]/Documents/x.md");
  });

  it("redacts Linux home paths", () => {
    expect(redactPaths("/home/bob/notes")).toBe("/home/[user]/notes");
  });

  it("redacts Windows user paths", () => {
    expect(redactPaths(String.raw`C:\Users\carol\AppData`)).toBe(
      String.raw`C:\Users\[user]\AppData`,
    );
  });

  it("redacts Anthropic API keys", () => {
    expect(redactSecrets("key sk-ant-api03-ABCdef123_xyz here")).toBe("key sk-ant-[redacted] here");
  });

  it("redacts bearer tokens", () => {
    expect(redactSecrets("Bearer abcdefghijkl0123456789")).toBe("Bearer [redacted]");
  });

  it("combined scrub handles path + secret in one string", () => {
    expect(scrub("/Users/dan/.env had sk-ant-api03-SECRETSECRET12")).toBe(
      "/Users/[user]/.env had sk-ant-[redacted]",
    );
  });

  it("leaves benign strings untouched", () => {
    expect(scrub("TypeError: cannot read property foo of undefined")).toBe(
      "TypeError: cannot read property foo of undefined",
    );
  });
});
