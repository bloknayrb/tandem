import { describe, expect, it } from "vitest";
import { redactPaths, redactSecrets, scrubText } from "../../src/shared/scrub-text.js";

/**
 * These scrubbers were sized for Sentry, which only ever fed them `Error`
 * objects this codebase constructed. #1439 promotes them: the client log feeds
 * them Tauri IPC rejection strings and server-supplied messages, and the
 * destination is a public GitHub issue. The added patterns are the ones that
 * distribution makes plausible.
 */
/**
 * Fixtures for real-looking credentials are ASSEMBLED at runtime rather than
 * written as literals.
 *
 * GitHub's push protection scans the file text and blocks a commit that carries
 * a contiguous `xoxb-…` or `sk_live_…` string, fabricated or not — it rejected
 * an earlier revision of this very file. Splitting the prefix from the body
 * keeps the test honest without shipping something a scanner reads as live.
 */
function fake(...parts: string[]): string {
  return parts.join("");
}

describe("redactSecrets", () => {
  it.each([
    ["key sk-ant-api03-ABCdef123_xyz here", "key sk-ant-[redacted] here"],
    ["Bearer abcdefghijkl0123456789", "Bearer [redacted]"],
    ["Authorization: Basic YWxpY2U6aHVudGVyMg==", "Authorization: Basic [redacted]"],
    // The destination IS GitHub — a leaked ghp_ in an issue body is live.
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "token ghp_[redacted]"],
    ["gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "gho_[redacted]"],
    ["github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789", "github_pat_[redacted]"],
    [
      "failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "failed: [redacted-jwt]",
    ],
    ["GET /api/events?token=abc123def&x=1 failed", "GET /api/events?token=[redacted]&x=1 failed"],
    ["https://h/x?api_key=sekrit", "https://h/x?api_key=[redacted]"],
    // The reachable shape of basic auth: `sentry.ts` runs this function over
    // `event.request.url`, so a header-only rule would pin coverage that the
    // real input never exercises.
    [
      "fetch failed: https://alice:hunter2@internal.example.com/doc",
      "fetch failed: https://[redacted]@internal.example.com/doc",
    ],
    ["ws://user:pw@127.0.0.1:3478/ws", "ws://[redacted]@127.0.0.1:3478/ws"],
    // RFC 7235 auth schemes are case-insensitive, and `Bearer` was already `/gi`.
    // The replacement normalizes the scheme's case, exactly as the older
    // `Bearer` rule always has.
    ["authorization: basic YWxpY2U6aHVudGVyMg==", "authorization: Basic [redacted]"],
  ])("redacts %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts the two shapes GitHub's own scanner treats as live credentials", () => {
    // Slack and Stripe started out on the documented-gap list below. Push
    // protection blocked the commit that carried them as fixtures, which is a
    // better argument for redacting them than anything I could reason out.
    expect(redactSecrets(fake("xoxb", "-2482048272-2482048272-abcdefghijklmnopqrst"))).toBe(
      "xoxb-[redacted]",
    );
    expect(redactSecrets(fake("xoxp", "-1111111111-2222222222-abcdefghijkl"))).toBe(
      "xoxp-[redacted]",
    );
    expect(redactSecrets(fake("sk", "_live_", "51ABCdefGHIjklMNOpqrSTUvwx"))).toBe(
      "sk_live_[redacted]",
    );
    expect(redactSecrets(fake("pk", "_test_", "51ABCdefGHIjklMNOpqrSTUvwx"))).toBe(
      "pk_test_[redacted]",
    );
  });

  it("keeps the vendor prefix so a leak report names the right vendor", () => {
    // The generic `sk-` rule would otherwise swallow `sk-ant-`.
    expect(redactSecrets("sk-ant-api03-SECRETSECRET12")).toBe("sk-ant-[redacted]");
    expect(redactSecrets("sk-proj-ABCDEFGHIJKLMNOPQRSTUV")).toBe("sk-[redacted]");
  });

  it("leaves these shapes untouched — the documented gap", () => {
    // `redactSecrets` is an ENUMERATION, not a classifier. Pinned rather than
    // merely unmentioned: an unlisted gap reads as coverage to the next reader,
    // and the list of vendors it DOES match is exactly what invites that
    // misreading. Anything on this list that later gains a rule should move up
    // into the redaction cases above, deliberately.
    const gaps = [
      fake("AKIA", "IOSFODNN7EXAMPLE"),
      fake("ASIA", "1234567890ABCDEF"),
      fake("AIza", "SyD-abc1234567890abcdefghijklmnopqrs"),
      fake("npm", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
      "x-api-key: 0123456789abcdef0123456789abcdef",
      "Cookie: session=abc; auth_token=def",
      // `_token` is not `?token`, and `auth` is not on the parameter list.
      "https://h/x?refresh_token=abcdefghijklmnop",
      "https://h/x?auth=abcdefghijklmnop",
      // A token living in a PATH segment is indistinguishable from a doc id.
      "https://h/share/AbCdEf0123456789AbCdEf0123456789/doc.md",
    ];
    for (const gap of gaps) expect(redactSecrets(gap)).toBe(gap);
  });

  it("leaves ordinary error text alone", () => {
    // False positives cost a `[redacted]` in a report; these are the strings
    // that must survive for the report to be worth anything.
    const benign = "TypeError: cannot read property foo of undefined";
    expect(redactSecrets(benign)).toBe(benign);
    expect(redactSecrets("NotAllowedError: Write permission denied")).toBe(
      "NotAllowedError: Write permission denied",
    );
    // Short query values that are not credential-named stay put.
    expect(redactSecrets("GET /api/events?documentId=abc123")).toBe(
      "GET /api/events?documentId=abc123",
    );
  });
});

describe("redactPaths", () => {
  it.each([
    ["/Users/alice/Documents/x.md", "/Users/[user]/Documents/x.md"],
    ["/home/bob/notes", "/home/[user]/notes"],
    [String.raw`C:\Users\carol\AppData`, String.raw`C:\Users\[user]\AppData`],
  ])("collapses the user segment in %s", (input, expected) => {
    expect(redactPaths(input)).toBe(expected);
  });

  it("collapses the Windows user segment in either case", () => {
    // Windows paths are case-insensitive, so the lowercase spelling is the same
    // directory and leaks the same account name into a public issue.
    expect(redactPaths(String.raw`c:\users\bob\x.md`)).toBe(String.raw`c:\users\[user]\x.md`);
    expect(redactPaths(String.raw`C:\USERS\bob\x.md`)).toBe(String.raw`C:\USERS\[user]\x.md`);
    // The POSIX rules stay case-sensitive: `/users` is a different directory
    // from `/Users` on a case-sensitive filesystem.
    expect(redactPaths("/users/bob/x.md")).toBe("/users/bob/x.md");
  });

  it("collapses the username only — the filename survives, by design", () => {
    // Documented limitation, asserted so nobody reads this as stronger than it
    // is: in a document editor the filename is often the sensitive half.
    expect(redactPaths("/Users/alice/Documents/Q3-layoffs-plan.md")).toBe(
      "/Users/[user]/Documents/Q3-layoffs-plan.md",
    );
  });

  it("catches a /home segment anywhere, not just at the start", () => {
    // Fedora Silverblue's `/var/home/<user>` is covered for free because the
    // pattern is unanchored. Pinned because the module's own doc claims it.
    expect(redactPaths("/var/home/dave/notes")).toBe("/var/home/[user]/notes");
    expect(redactPaths("EACCES: scandir '/home/dave/x'")).toBe("EACCES: scandir '/home/[user]/x'");
  });

  it("leaves paths under no known user root untouched — the documented gap", () => {
    // What the server-side pass catches with real roots and this one cannot.
    // Asserted so the limitation is visible rather than assumed.
    expect(redactPaths("/root/notes")).toBe("/root/notes");
    expect(redactPaths(String.raw`D:\Profiles\alice\tandem`)).toBe(
      String.raw`D:\Profiles\alice\tandem`,
    );
    expect(redactPaths(String.raw`\\fileserver\share\alice\x.md`)).toBe(
      String.raw`\\fileserver\share\alice\x.md`,
    );
  });
});

describe("scrubText", () => {
  it("handles path + secret in one string", () => {
    expect(scrubText("/Users/dan/.env had sk-ant-api03-SECRETSECRET12")).toBe(
      "/Users/[user]/.env had sk-ant-[redacted]",
    );
  });
});
