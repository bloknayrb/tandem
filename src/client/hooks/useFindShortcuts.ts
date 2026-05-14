/**
 * Returns true if the find bar has an active query and Ctrl+G / Ctrl+Shift+G
 * should dispatch find-next / find-prev. When false, the caller should open the
 * find bar instead.
 */
export function shouldDispatchFindNav(state: { query: string } | null | undefined): boolean {
  return !!state?.query;
}
