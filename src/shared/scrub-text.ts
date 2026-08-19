/**
 * Scrubbing for free-form text that leaves the process — a crash report, or a
 * report body a user is about to paste into a public GitHub issue.
 *
 * Both halves started life in `src/client/sentry.ts` and moved here when a
 * second consumer appeared (`client/utils/client-log.ts`, #1439). Two copies of
 * a privacy control is how a hardening pass ends up fixing only one of them.
 *
 * ## Scope, stated plainly
 *
 * `redactPaths` collapses the **username segment only**: `/Users/alice/Docs/
 * board-minutes.md` becomes `/Users/[user]/Docs/board-minutes.md`. Filenames and
 * directories survive, and in a document editor those are often the sensitive
 * part. This is deliberately **narrower than the server-side pass** in
 * `shared/redact-user-paths.ts`, which is handed real roots (`$HOME`,
 * `$USERPROFILE`, `TANDEM_APP_DATA_DIR`, `XDG_DATA_HOME`, `LOCALAPPDATA`) and so
 * also catches `/root/…`, redirected Windows profiles (`D:\Profiles\<user>`),
 * UNC shares and app-data dirs outside home. (Fedora Silverblue's
 * `/var/home/<user>` IS covered here — the patterns are unanchored — so the gap
 * is narrower than "only $HOME-shaped paths"; `tests/shared/scrub-text.test.ts`
 * pins both the coverage and the gap.) A caller with access to those roots should use
 * that module instead; this one exists for callers that have none — the WebView
 * cannot read the environment.
 *
 * `redactSecrets` is an ENUMERATION, not a classifier: it matches the credential
 * shapes this codebase plausibly produces, and everything else passes through.
 * Known gaps — AWS (`AKIA…`), Google (`AIza…`), npm (`npm_…`), bare
 * `x-api-key:` and `Cookie:` header values, `?refresh_token=`/`?auth=` query
 * names, and a token living in a URL PATH segment — are pinned by a "documented gap" test
 * in `tests/shared/scrub-text.test.ts`. Pinned rather than merely unmentioned:
 * an unlisted gap reads as coverage to the next reader, and the enumerated list
 * above is exactly the thing that invites that misreading.
 *
 * ## Purity
 *
 * No `process`, no `os`, no Node builtins, no imports at all: this module is
 * bundled into the browser client, where `process` is not defined (`vite.config.ts`
 * declares no `define` for it) and touching it would be a runtime ReferenceError.
 */

/**
 * Redact anything that looks like a credential.
 *
 * Conservative by construction: a false positive costs a `[redacted]` in a bug
 * report, a false negative puts a live token in a public issue. The list grew
 * with the input distribution — Sentry only ever fed this `Error` objects, while
 * the client log feeds it Tauri IPC rejection strings and (after the #1439
 * follow-up) arbitrary server-supplied messages.
 */
export function redactSecrets(input: string): string {
  return (
    input
      // Anthropic keys first: the generic `sk-` rule below would otherwise
      // swallow the `sk-ant-` prefix that identifies which vendor leaked.
      .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[redacted]")
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [redacted]")
      .replace(/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, "Basic [redacted]")
      // GitHub's token family. Worth naming explicitly because the destination
      // of this text IS a GitHub issue: a leaked `ghp_` there is live, public,
      // and scoped to the account filing the report.
      .replace(/\bgh([pousr])_[A-Za-z0-9]{16,}/g, "gh$1_[redacted]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]")
      // Slack and Stripe. These two are here rather than in the documented-gap
      // list below because GitHub's own push protection recognises both shapes
      // as live credentials — it blocked a commit carrying them as test
      // fixtures — which is the strongest available evidence that they read as
      // real and belong in a scrubber whose output lands in a GitHub issue.
      .replace(/\bxox([abeprs])-[A-Za-z0-9-]{10,}/g, "xox$1-[redacted]")
      .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_[redacted]")
      // JWTs: three base64url segments. The header always starts `eyJ` because
      // every JWT header begins `{"`.
      .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
      // `scheme://user:pass@host` — the shape that actually reaches this
      // function, since `sentry.ts` runs it over `event.request.url`. An
      // `Authorization: Basic` rule without this one is the trap: a reader
      // checking "is basic auth handled?" gets yes from the header form and no
      // from the reachable one.
      .replace(/(\w+:\/\/)[^/\s@]+:[^/\s@]+@/g, "$1[redacted]@")
      // Credential-bearing query parameters. Already an assumed input shape:
      // `sentry.ts` runs this same function over `event.request.url`.
      .replace(
        /([?&](?:token|key|access_token|api_key|apikey|secret|password|sig|signature)=)[^&\s"'`]+/gi,
        "$1[redacted]",
      )
  );
}

/**
 * Replace absolute home-dir prefixes with a placeholder user segment.
 *
 * The WebView can't read `$HOME`, but file paths surfaced in error messages
 * typically embed a recognizable `/Users/<name>/`, `/home/<name>/`, or
 * `C:\Users\<name>\` segment. Collapse the user segment so a report can't
 * fingerprint the OS account.
 */
export function redactPaths(input: string): string {
  return (
    input
      .replace(/(\/Users\/)[^/\\]+/g, "$1[user]")
      .replace(/(\/home\/)[^/\\]+/g, "$1[user]")
      // `i` on THIS rule only. Windows paths are case-insensitive, so
      // `c:\users\bob` and `C:\USERS\bob` name the same directory and leak the
      // same account name; the two POSIX rules above are on case-SENSITIVE
      // filesystems where `/Users` and `/users` are genuinely different
      // directories, and an `i` there would collapse an unrelated one.
      .replace(/([A-Za-z]:\\users\\)[^\\]+/gi, "$1[user]")
  );
}

/** Secrets then paths — the order the Sentry scrubber has always used. */
export function scrubText(input: string): string {
  return redactPaths(redactSecrets(input));
}
