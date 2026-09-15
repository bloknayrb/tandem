/**
 * Read the most actionable message out of a failed `fetch` response (#1792).
 *
 * The server answers some failures with a body the user can act on — a
 * downgraded `integrations.json` answers 409 with the version mismatch and what
 * to do about it — while a bare `HTTP <status>` line leaves a dead surface with
 * no hint. Every caller needs the same three steps (parse defensively, accept
 * only a non-empty string, otherwise fall back), so they live here once.
 *
 * Total: a body that is absent, not JSON, or carries no usable `message`
 * yields `fallback`. Never throws.
 */
export async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" && body.message.length > 0 ? body.message : fallback;
}
