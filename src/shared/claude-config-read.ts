/**
 * The UNC-screened reader for a Claude Code config file, shared by
 * `tandem doctor` (`src/cli/doctor.ts`, which re-exports it) and the launcher's
 * run settings (`src/server/launcher/run-files.ts`, #2358 PR 3a, Ruling D3).
 * Moved here unchanged so the server does not import the CLI's doctor.
 */

import { readFileSync } from "node:fs";
import { rejectUnsafeWindowsPrefix } from "./windows-path-safety.js";

/**
 * Outcome of reading a Claude client config. Distinct from {@link JsonRead} by
 * one case: `unsafe-path`, the screen that must happen before the syscall.
 *
 * **It carries no path and no error detail, and that is load-bearing.** These
 * files hold bearer tokens and `env.TANDEM_AUTH_TOKEN`; a V8 `SyntaxError`
 * embeds a snippet of the source. The whole report reaches the Copy
 * Diagnostics clipboard and `tandem_diagnostics`, and the MCP tool applies no
 * redaction at all (`src/server/mcp/diagnostics.ts`). A field here is a field
 * a caller can interpolate into a message, so the type does not offer one —
 * every existing rejection message names the *class* of path, never the path,
 * and this keeps that a property of the type rather than of convention.
 */
export type ClaudeConfigRead =
  | { kind: "unsafe-path" }
  | { kind: "absent" }
  /** The open or read failed — EACCES, EISDIR, ELOOP. Nothing is known about the contents. */
  | { kind: "unreadable" }
  /**
   * Read fine, but it holds nothing: zero bytes, whitespace only, or a lone
   * BOM. Split out from `malformed` because `applyConfig` starts FRESH on this
   * input rather than refusing it (#1802), so the two must not share a remedy.
   */
  | { kind: "empty" }
  /** Read fine, but it is not a JSON object: a parse error, or a literal `null`/array/scalar. */
  | { kind: "malformed" }
  | { kind: "ok"; value: Record<string, unknown> };

/**
 * The one way doctor reads a Claude client config (#1417).
 *
 * Screens the path before touching the filesystem: on Windows a UNC or
 * device-namespace path performs the SMB handshake that leaks an NTLM hash,
 * and enterprise folder redirection routinely puts a profile on a share.
 * Doctor is the one command whose whole job is to read these files, so it is
 * also the one most likely to be pointed at a redirected profile.
 *
 * No `existsSync` pre-flight: the read has to be in a `try` regardless, so a
 * separate stat is a second syscall answering a question this one already
 * answers, plus a TOCTOU window. This adopts `checkDesktopMcpConfig`'s prior
 * shape for all three callers; `checkUserMcpConfig` **did** have such a
 * pre-flight and loses it here. The report is unchanged (ENOENT reaches the
 * same "not found" branch) except when the file exists but its parent
 * directory is unreadable, where the old code said "not found" and this says
 * "could not be read" — the more accurate of the two.
 *
 * **Its screen is a backstop, and it is exported so that backstop is covered
 * rather than merely asserted.** Every caller also screens its raw input, and
 * on Windows that makes this branch unreachable — `path.win32.join` preserves
 * every hostile prefix, so the input screen catches all fourteen corpus rows
 * first. It is *not* unreachable in general: on POSIX a `$HOME` of a single
 * backslash passes the input screen (no leading `\\`) and then `path.posix.join`
 * derives `\/.claude/settings.json`, which this rejects. An earlier revision of
 * this comment asserted the branch could not fire at all; that was measured
 * wrong. Deleting the screen still leaves every *integration* assertion green,
 * which is why the corpus is also driven through this function directly.
 *
 * The branch earns its place beyond the backstop argument: it is what makes the
 * NEXT check that reads a Claude config safe by construction even if its author
 * forgets the input screen, which is exactly how `checkTandemPlugin` became
 * #1417's eighth site.
 *
 * **Not written as `screen-then-delegate-to-readJson`, though the bodies look
 * alike.** `readJson` collapses an IO failure and a parse failure into one
 * `unreadable`, and separating them is the point here: the caller printed "is
 * malformed JSON" for `EACCES`, asserting as fact something it could not know
 * and prescribing a rewrite that fails the same way. Delegating would put that
 * distinction back behind `reason`, the field this type deliberately lacks.
 * `tests/cli/doctor-path-safety.test.ts` fences `readJson` away from these
 * files at the source level, so the two readers stay separate on purpose.
 */
export function readClaudeConfig(path: string): ClaudeConfigRead {
  if (rejectUnsafeWindowsPrefix(path) !== null) return { kind: "unsafe-path" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
  // Strip a leading BOM and screen for emptiness BEFORE parsing — the same pair
  // `applyConfig` and `readConfigForMutation` run, in the same order. (Round-3
  // review: this claimed the match already, and `readConfigForMutation` had no
  // emptiness screen at all, so a zero-byte config was `empty` here and
  // `malformed-json` in the boot sweep's log. It has one now; keep the three in
  // step, because the reason a user is shown must not depend on which surface
  // found the file.) Without this pair
  // `malformed` was WIDER than the refusal whose remedy it now prescribes: a
  // BOM-prefixed but perfectly valid config parses fine for `applyConfig`
  // (which strips U+FEFF), and a zero-byte one makes it start fresh — yet both
  // were reported here as "not valid JSON … Tandem will not rewrite a config it
  // cannot parse", a statement false of both, naming no working command. A
  // crash-truncated `~/.claude.json` is the concrete case: `setup --apply`
  // fixes it outright, and the old wording sent the user to hand-edit a file
  // with no content in it.
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // `/\S/.test`, not `trim() !== ""`: same predicate, no trimmed copy of a file
  // `applyConfig` permits to reach 16 MiB.
  if (!/\S/.test(body)) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "malformed" };
  }
  // A literal `null`, an array or a scalar parses fine and then answers every
  // `?.mcpServers` lookup with `undefined` — indistinguishable, at the call
  // site, from a well-formed config with nothing registered. Callers would
  // report "tandem is not registered" and prescribe `setup --apply` for a file
  // that is corrupt, so the narrowing happens here rather than at each of them.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}
