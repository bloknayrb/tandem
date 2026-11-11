/**
 * SemVer precedence for two version strings, prereleases included.
 *
 * Shared by `tandem doctor` (is the installed plugin older than this build?)
 * and the Linux AppImage's bridge copies (`server/integrations/bridge-copy.ts`:
 * which `bin/<version>` is older?), so the two cannot order versions
 * differently. Callers screen the SHAPE first; this compares whatever parses
 * as `x.y.z[-pre][+build]` and calls anything else "not older".
 */

/** `a < b` for two digit strings, exactly — no `Number` rounding past 2^53. */
function isSmallerNumeral(a: string, b: string): boolean {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  return x.length !== y.length ? x.length < y.length : x < y;
}

/**
 * SemVer §11 identifier precedence: numeric identifiers compare numerically
 * and sit below alphanumeric ones, alphanumeric ones compare by ASCII, and a
 * list that is a strict prefix of the other is the lower.
 */
function isOlderPrerelease(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (isSmallerNumeral(x, y)) return true;
      if (isSmallerNumeral(y, x)) return false;
      continue; // `01` and `1`: same number, look further.
    }
    if (xNumeric !== yNumeric) return xNumeric;
    return x < y;
  }
  return a.length < b.length;
}

function parse(v: string): { core: [string, string, string]; pre: string[] } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (m === null) return null;
  return { core: [m[1], m[2], m[3]] as [string, string, string], pre: m[4] ? m[4].split(".") : [] };
}

/** Is `a` strictly older than `b`? `false` when either does not parse. */
export function isOlderSemver(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return false;
  for (let i = 0; i < 3; i++) {
    if (isSmallerNumeral(pa.core[i] as string, pb.core[i] as string)) return true;
    if (isSmallerNumeral(pb.core[i] as string, pa.core[i] as string)) return false;
  }
  // Equal triplets: a release outranks any of its prereleases.
  if (pa.pre.length === 0) return false;
  if (pb.pre.length === 0) return true;
  return isOlderPrerelease(pa.pre, pb.pre);
}
