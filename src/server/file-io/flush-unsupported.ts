/**
 * errnos meaning "this filesystem cannot fsync", not "the write failed".
 * Dependency-free on purpose: the CLI's config writers import it, and
 * `file-io/index.ts` would drag the format adapters into the CLI bundle.
 */
const FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** True when `err` says the filesystem refused an fsync. */
export function isFlushUnsupported(err: unknown): boolean {
  return FLUSH_UNSUPPORTED.has((err as NodeJS.ErrnoException | undefined)?.code ?? "");
}
