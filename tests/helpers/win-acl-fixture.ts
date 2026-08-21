/**
 * Shared fixture for the two Windows-only suites that reproduce the #1299
 * poisoned install with real `icacls` (`tests/server/integrations/acl-win.test.ts`
 * and `tests/server/file-io/doc-backup-acl-repair.test.ts`).
 *
 * The state both suites need is a `child` directory with an **empty but
 * UNPROTECTED** DACL: nothing grants access, yet inheritance is still enabled
 * so that a later inheritable grant on `root` can repair it. That is exactly
 * what the pre-fix code produced on a user's machine, and both halves matter —
 * an empty DACL that is also *protected* would deny access just the same but
 * could never be repaired, which is a different bug from the one under test.
 *
 * Producing it is host-dependent, which is what #1529 ran into. See
 * `normalizePre1299Poison` for the measurements.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { systemBin } from "../../src/server/platform.js";

const execFileAsync = promisify(execFile);

/** Well-known, locale-independent SIDs that `/inheritance:r` may leave behind. */
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/** Current user's SID — the principal the production ACL grants to. */
export async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(systemBin("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return stdout.split(",")[1].replace(/"/g, "").trim();
}

/**
 * Force `root` to the DACL the pre-#1299 grant was *supposed* to leave: a
 * single NON-inheritable full-control ACE for the current user, and nothing
 * else. With no inheritable ACE on the parent, Windows recomputes every
 * existing child's inherited entries to nothing — the empty DACL that is the
 * bug.
 *
 * Call this immediately after the verbatim old grant
 * (`icacls <root> /inheritance:r /grant:r *<sid>:F`, however the suite issues
 * it). On a host where that grant already did the right thing this is a no-op;
 * where it did not, it repairs the fixture rather than the product.
 *
 * Why it is needed — `/inheritance:r` is NOT host-independent (#1529):
 * - Windows 11 25H2 (`10.0.26200`): `/inheritance:r` REMOVES the inherited
 *   ACEs. `root` is left with `<user>:(F)` alone and `child` goes empty, so
 *   the poison reproduces with no help.
 * - GitHub's `windows-latest` (Server 2025) image: `/inheritance:r` behaves
 *   like `:d` — it CONVERTS the inherited ACEs to explicit ones that keep
 *   their `(OI)(CI)` flags. Measured there, `root` kept SYSTEM,
 *   BUILTIN\Administrators and the runner user as explicit `(OI)(CI)(F)`
 *   with no `(I)` marker, all three of which then propagate straight back
 *   down. `child` ended up `(I)(OI)(CI)(F)` full control and both suites'
 *   positive controls fired.
 *
 * `/grant:r` alone cannot undo that: measured on 25H2 against a reconstruction
 * of the runner's DACL, it replaces neither the SYSTEM/Administrators ACEs nor
 * the user's *second*, inheritable ACE, so the child stays reachable. The
 * removal has to be explicit, the user's own SID included.
 */
export async function normalizePre1299Poison(root: string, sid: string): Promise<void> {
  const icacls = systemBin("icacls.exe");
  // Drop every principal `/inheritance:r` may have converted, the current user
  // included — `/grant:r` replaces one ACE for a SID, not a duplicate pair.
  // Removing a SID that has no ACE is a no-op that still exits 0.
  await execFileAsync(icacls, [
    root,
    "/remove:g",
    `*${SYSTEM_SID}`,
    `*${ADMINISTRATORS_SID}`,
    `*${sid}`,
  ]);
  // ...then restore exactly the one non-inheritable ACE the old code left.
  await execFileAsync(icacls, [root, "/grant:r", `*${sid}:F`]);
}

/**
 * Fixture precondition: `child` must actually be inaccessible before a suite
 * goes on to prove anything about recovering from it.
 *
 * This THROWS rather than skipping. A fixture that cannot reach the poisoned
 * state has not shown the product is fine, it has shown the test is void —
 * and silently skipping instead of failing is the #1529 defect these suites
 * exist to close. The DACLs are dumped into the message because the cause is
 * always a host difference in how `icacls` computed them.
 */
export async function assertPre1299PoisonTook(root: string, child: string): Promise<void> {
  try {
    fs.readdirSync(child);
  } catch {
    return; // Denied, as intended.
  }
  const icacls = systemBin("icacls.exe");
  const dump = async (p: string) =>
    await execFileAsync(icacls, [p]).then(
      ({ stdout }) => stdout.trim(),
      (err) => `<icacls failed: ${String(err)}>`,
    );
  throw new Error(
    "#1299 fixture precondition failed: the poisoned child is still readable, so " +
      "nothing this suite asserts about recovery would mean anything. `icacls` on " +
      "this host did not leave the child with an empty DACL.\n" +
      `root  DACL:\n${await dump(root)}\n` +
      `child DACL:\n${await dump(child)}`,
  );
}

/**
 * Make a poisoned tree deletable again. An empty DACL defeats `fs.rm`, and the
 * tree may still be poisoned if an assertion threw mid-test.
 */
export async function restoreAccessForCleanup(root: string, sid: string): Promise<void> {
  await execFileAsync(systemBin("icacls.exe"), [root, "/grant", `*${sid}:(OI)(CI)F`]).catch(
    () => {},
  );
}
